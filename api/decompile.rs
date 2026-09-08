// Copyright (c) 2026 SuiScope contributors
// SPDX-License-Identifier: MIT

use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sui_scope_rust::{decode_graphql_module_response, decompile_verified_bytecode};
use vercel_runtime::{Error, Request, run, service_fn};

const MODULE_QUERY: &str = r#"
    query ModuleBytecode($address: SuiAddress!, $module: String!, $version: UInt53) {
        object(address: $address, version: $version) {
          package: asMovePackage {
            address
            version
            module(name: $module) {
                name
                bytes
            }
            linkage {
                originalId
                upgradedId
                version
            }
          }
        }
    }
"#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecompileRequest {
    package_version: Option<u64>,
    package_id: String,
    module: String,
    #[serde(default = "default_network")]
    network: String,
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

fn graphql_endpoint(network: &str) -> Result<String, Error> {
    let (variable, fallback) = match network {
        "mainnet" => (
            "SUI_MAINNET_GRAPHQL",
            "https://graphql.mainnet.sui.io/graphql",
        ),
        "testnet" => (
            "SUI_TESTNET_GRAPHQL",
            "https://graphql.testnet.sui.io/graphql",
        ),
        "devnet" => (
            "SUI_DEVNET_GRAPHQL",
            "https://graphql.devnet.sui.io/graphql",
        ),
        _ => return Err(invalid("Unsupported Sui network")),
    };
    Ok(std::env::var(variable).unwrap_or_else(|_| fallback.to_owned()))
}

async fn fetch_chain_module(request: &DecompileRequest) -> Result<(String, Vec<u8>, Value), Error> {
    if request.module.is_empty()
        || !request.module.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || (byte.is_ascii_alphanumeric() && (index > 0 || !byte.is_ascii_digit()))
        })
    {
        return Err(invalid("Invalid Move module name"));
    }

    let package_id = normalize_package_id(&request.package_id)?;
    if matches!(package_id.trim_start_matches("0x").trim_start_matches('0'),
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8") {
        return Err(invalid("System addresses 0x1 through 0x8 are excluded from decompilation"));
    }
    let response = reqwest::Client::new()
        .post(graphql_endpoint(&request.network)?)
        .json(&json!({
            "query": MODULE_QUERY,
            "variables": {
                "address": package_id,
                "version": request.package_version,
                "module": request.module
            }
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;

    if let Some(version) = request.package_version {
        if response["data"]["object"]["package"]["version"].as_u64() != Some(version) {
            return Err(invalid("Package version mismatch"));
        }
    }
    let (bytecode, linkage) =
        decode_graphql_module_response(response, &package_id, &request.module).map_err(invalid)?;
    Ok((package_id, bytecode, linkage))
}

async fn handler(request: Request) -> Result<Value, Error> {
    let body = request.into_body().collect().await?.to_bytes();
    if body.len() > 16 * 1024 {
        return Err(invalid("Request body is too large"));
    }
    let input: DecompileRequest = serde_json::from_slice(&body)
        .map_err(|error| invalid(format!("Invalid request body: {error}")))?;
    let (package_id, bytecode, linkage_table) = fetch_chain_module(&input).await?;
    let (source, verification) = decompile_verified_bytecode(&bytecode).map_err(invalid)?;

    Ok(json!({
        "packageId": package_id,
        "packageVersion": input.package_version,
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
