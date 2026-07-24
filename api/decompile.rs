// Copyright (c) 2026 SuiScope contributors
// SPDX-License-Identifier: MIT

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use sui_scope_rust::decompile_verified_bytecode;
use vercel_runtime::{Error, Request, run, service_fn};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecompileRequest {
    package_id: String,
    module: String,
    #[serde(default = "default_network")]
    network: String,
}

#[derive(Deserialize)]
struct RpcEnvelope {
    result: Option<RpcResult>,
    error: Option<RpcError>,
}

#[derive(Deserialize)]
struct RpcResult {
    data: Option<RpcData>,
}

#[derive(Deserialize)]
struct RpcData {
    bcs: Option<PackageBcs>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageBcs {
    data_type: String,
    module_map: BTreeMap<String, String>,
    #[serde(default)]
    linkage_table: Value,
}

#[derive(Deserialize)]
struct RpcError {
    message: Option<String>,
}

fn default_network() -> String {
    "mainnet".to_owned()
}

fn invalid(message: impl Into<String>) -> Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message.into()).into()
}

fn normalize_package_id(value: &str) -> Result<String, Error> {
    let hex = value.trim().strip_prefix("0x").unwrap_or(value.trim());
    if hex.is_empty() || hex.len() > 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid("Invalid Sui package ID"));
    }
    Ok(format!("0x{hex:0>64}", hex = hex.to_ascii_lowercase()))
}

fn rpc_endpoint(network: &str) -> Result<String, Error> {
    let (variable, fallback) = match network {
        "mainnet" => (
            "SUI_MAINNET_RPC",
            "https://fullnode.mainnet.sui.io:443",
        ),
        "testnet" => (
            "SUI_TESTNET_RPC",
            "https://fullnode.testnet.sui.io:443",
        ),
        "devnet" => ("SUI_DEVNET_RPC", "https://fullnode.devnet.sui.io:443"),
        _ => return Err(invalid("Unsupported Sui network")),
    };
    Ok(std::env::var(variable).unwrap_or_else(|_| fallback.to_owned()))
}

async fn fetch_chain_module(
    request: &DecompileRequest,
) -> Result<(String, Vec<u8>, Value), Error> {
    if request.module.is_empty()
        || !request.module.bytes().enumerate().all(|(index, byte)| {
            byte == b'_'
                || (byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit()))
        })
    {
        return Err(invalid("Invalid Move module name"));
    }

    let package_id = normalize_package_id(&request.package_id)?;
    let response = reqwest::Client::new()
        .post(rpc_endpoint(&request.network)?)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sui_getObject",
            "params": [package_id, { "showBcs": true }]
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<RpcEnvelope>()
        .await?;

    if let Some(error) = response.error {
        return Err(invalid(
            error.message.unwrap_or_else(|| "Sui RPC error".to_owned()),
        ));
    }
    let bcs = response
        .result
        .and_then(|result| result.data)
        .and_then(|data| data.bcs)
        .ok_or_else(|| invalid("Sui RPC did not return package BCS"))?;
    if bcs.data_type != "package" {
        return Err(invalid("Address is not a Move package"));
    }
    let encoded = bcs
        .module_map
        .get(&request.module)
        .ok_or_else(|| invalid(format!("Package does not contain module {}", request.module)))?;
    let bytecode = BASE64
        .decode(encoded)
        .map_err(|error| invalid(format!("Invalid module bytecode: {error}")))?;
    Ok((package_id, bytecode, bcs.linkage_table))
}

async fn handler(request: Request) -> Result<Value, Error> {
    let body = request.into_body().collect().await?.to_bytes();
    if body.len() > 16 * 1024 {
        return Err(invalid("Request body is too large"));
    }
    let input: DecompileRequest = serde_json::from_slice(&body)
        .map_err(|error| invalid(format!("Invalid request body: {error}")))?;
    let (package_id, bytecode, linkage_table) = fetch_chain_module(&input).await?;
    let (source, verification) =
        decompile_verified_bytecode(&bytecode).map_err(invalid)?;

    Ok(json!({
        "packageId": package_id,
        "module": input.module,
        "network": input.network,
        "source": source,
        "engine": "rust-move-decompiler",
        "fallback": false,
        "verification": verification,
        "linkageTable": linkage_table
    }))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    run(service_fn(handler)).await
}
