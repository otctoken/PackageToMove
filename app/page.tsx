"use client";

import {
  Activity,
  ArrowRight,
  Box,
  Braces,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Code2,
  Copy,
  Download,
  ExternalLink,
  GitBranch,
  GitFork,
  Layers3,
  LoaderCircle,
  Network as NetworkIcon,
  PackageSearch,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AnalyzeResult,
  DecompileMetadata,
  Network,
  PackageResult,
  RustDecompileResponse,
} from "@/lib/types";

const EXAMPLES = [
  { label: "Sui Framework", value: "0x2" },
  { label: "Move Stdlib", value: "0x1" },
  { label: "Sui System", value: "0x3" },
];

function compactAddress(value: string, size = 7) {
  if (value.length <= size * 2 + 3) return value;
  return `${value.slice(0, size + 2)}…${value.slice(-size)}`;
}

function formatTime(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function explorerUrl(network: Network, id: string) {
  const segment = network === "mainnet" ? "mainnet" : network;
  return `https://suiscan.xyz/${segment}/object/${id}`;
}

function SourceView({ code }: { code: string }) {
  const lines = code.split("\n");
  return (
    <div className="code-scroll">
      <pre className="source-code" aria-label="Move source code">
        {lines.map((line, index) => (
          <span className="code-line" key={`${index}-${line}`}>
            <span className="line-number">{String(index + 1).padStart(2, "0")}</span>
            <span className="line-content">{line || " "}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

function Stat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string | number;
  label: string;
}) {
  return (
    <div className="stat-card">
      <span className="stat-icon">{icon}</span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function EmptyPreview() {
  return (
    <section className="empty-preview">
      <div className="preview-glow" />
      <div className="preview-window">
        <div className="preview-head">
          <span />
          <span />
          <span />
          <small>package.move</small>
        </div>
        <div className="preview-body">
          <div className="preview-tree">
            <p>DEPENDENCIES</p>
            <div className="tree-row active"><Box size={15} /> root_package</div>
            <div className="tree-row indent"><Box size={15} /> sui</div>
            <div className="tree-row indent"><Box size={15} /> move_stdlib</div>
          </div>
          <div className="preview-code" aria-hidden>
            <p><i>01</i><b>module</b> <em>0x2::coin</em> {"{"}</p>
            <p><i>02</i>&nbsp;&nbsp;<b>public struct</b> Coin&lt;T&gt; <b>has</b> key, store {"{"}</p>
            <p><i>03</i>&nbsp;&nbsp;&nbsp;&nbsp;id: UID,</p>
            <p><i>04</i>&nbsp;&nbsp;&nbsp;&nbsp;balance: Balance&lt;T&gt;,</p>
            <p><i>05</i>&nbsp;&nbsp;{"}"}</p>
            <p><i>06</i></p>
            <p><i>07</i>&nbsp;&nbsp;<b>public fun</b> value&lt;T&gt;(coin: &Coin&lt;T&gt;): u64</p>
            <p><i>08</i>&nbsp;&nbsp;{"{"} <span>/* reconstructed */</span> {"}"}</p>
            <p><i>09</i>{"}"}</p>
          </div>
        </div>
      </div>
      <div className="empty-copy">
        <span className="eyebrow"><Sparkles size={13} /> READY TO TRACE</span>
        <h2>从一个地址，看清整棵依赖树</h2>
        <p>输入已发布的 Package ID，查看模块、ABI、传递依赖与可读的 Move 反编译结果。</p>
      </div>
    </section>
  );
}

function DependencyPanel({
  packages,
  activeId,
  onSelect,
}: {
  packages: PackageResult[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const maxDepth = Math.max(...packages.map((pkg) => pkg.depth), 0);
  return (
    <aside className="dependency-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">PACKAGE GRAPH</span>
          <h3>依赖关系</h3>
        </div>
        <span className="count-badge">{packages.length}</span>
      </div>
      <div className="depth-track">
        <span>ROOT</span>
        <div className="track-line"><i style={{ width: `${Math.max(12, 100 / (maxDepth + 1))}%` }} /></div>
        <span>DEPTH {maxDepth}</span>
      </div>
      <div className="package-list">
        {packages.map((pkg) => (
          <button
            className={`package-row ${activeId === pkg.id ? "active" : ""}`}
            key={pkg.id}
            onClick={() => onSelect(pkg.id)}
            style={{ "--depth": Math.min(pkg.depth, 4) } as React.CSSProperties}
          >
            <span className={`package-dot ${pkg.status}`} />
            <span className="package-row-copy">
              <strong>{pkg.depth === 0 ? "Root package" : compactAddress(pkg.id, 5)}</strong>
              <small>{pkg.modules.length} modules · depth {pkg.depth}</small>
            </span>
            <ChevronDown size={15} className="row-chevron" />
          </button>
        ))}
      </div>
      <div className="legend">
        <span><i className="ok" /> 已解析</span>
        <span><i className="partial" /> 部分数据</span>
      </div>
    </aside>
  );
}

export default function Home() {
  const [packageId, setPackageId] = useState("");
  const [network, setNetwork] = useState<Network>("mainnet");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [activePackageId, setActivePackageId] = useState("");
  const [activeModule, setActiveModule] = useState("");
  const [activeTab, setActiveTab] = useState<"source" | "bytecode">("source");
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const [fullSources, setFullSources] = useState<Record<string, string>>({});
  const [decompileMetadata, setDecompileMetadata] = useState<
    Record<string, DecompileMetadata>
  >({});
  const [decompilingKey, setDecompilingKey] = useState("");
  const [decompileError, setDecompileError] = useState("");
  const [decompileRetry, setDecompileRetry] = useState(0);

  const activePackage = result?.packages.find((pkg) => pkg.id === activePackageId);
  const filteredModules = useMemo(
    () =>
      (activePackage?.modules ?? []).filter((module) =>
        module.name.toLowerCase().includes(filter.toLowerCase()),
      ),
    [activePackage, filter],
  );
  const module =
    activePackage?.modules.find((item) => item.name === activeModule) ??
    filteredModules[0];
  const sourceKey =
    activePackage && module ? `${activePackage.id}::${module.name}` : "";
  const fullSource = sourceKey ? fullSources[sourceKey] : undefined;
  const sourceMetadata = sourceKey ? decompileMetadata[sourceKey] : undefined;
  const visibleCode =
    activeTab === "source"
      ? fullSource ?? module?.source ?? ""
      : module?.disassembly ?? "// 此模块的原始反汇编暂不可用。";

  useEffect(() => {
    if (!activePackage) return;
    if (!activePackage.modules.some((item) => item.name === activeModule)) {
      setActiveModule(activePackage.modules[0]?.name ?? "");
    }
  }, [activePackage, activeModule]);

  useEffect(() => {
    if (!result || !activePackage || !module || !sourceKey || fullSource) return;
    const controller = new AbortController();
    const requestBody = JSON.stringify({
      packageId: activePackage.id,
      module: module.name,
      network: result.network,
    });
    setDecompilingKey(sourceKey);
    setDecompileError("");

    void (async () => {
      try {
        const response = await fetch("/api/decompile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
          signal: controller.signal,
        });
        const responseText = await response.text();
        let payload: RustDecompileResponse | { error?: string };
        try {
          payload = JSON.parse(responseText) as
            | RustDecompileResponse
            | { error?: string };
        } catch {
          throw new Error(
            response.ok
              ? "Rust 反编译服务返回了无效响应"
              : responseText.slice(0, 500) || "Rust 反编译服务不可用",
          );
        }
        if (!response.ok || !("source" in payload)) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : "Rust 反编译服务不可用",
          );
        }
        if (
          payload.verification.canonicalInput !== "sui-chain-bytecode" ||
          payload.verification.auditPolicy !== "fail-closed-v1" ||
          !payload.verification.bytecodeVerified ||
          !payload.verification.knownInstructionCoverage ||
          !payload.verification.controlFlowFullyStructured ||
          payload.verification.auditWarnings.length > 0
        ) {
          throw new Error(
            "反编译结果未通过全局 fail-closed 审计准入，已拒绝显示",
          );
        }
        setFullSources((current) => ({
          ...current,
          [sourceKey]: payload.source,
        }));
        setDecompileMetadata((current) => ({
          ...current,
          [sourceKey]: {
            engine: payload.engine,
            fallback: false,
            verification: payload.verification,
          },
        }));
        return;
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        throw new Error(
          cause instanceof Error
            ? cause.message
            : "Rust 反编译服务不可用；为避免误导，不使用未验证 fallback",
        );
      }
    })()
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setDecompileError(
          cause instanceof Error ? cause.message : "完整反编译失败",
        );
      })
      .finally(() => {
        setDecompilingKey((current) => (current === sourceKey ? "" : current));
      });
    return () => controller.abort();
  }, [activePackage, decompileRetry, fullSource, module, result, sourceKey]);

  async function analyze(event?: FormEvent, override?: string) {
    event?.preventDefault();
    const id = override ?? packageId;
    if (!id.trim()) {
      setError("请先输入 Sui Package ID");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packageId: id, network }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "分析失败");
      const data = payload as AnalyzeResult;
      setResult(data);
      setFullSources({});
      setDecompileMetadata({});
      setDecompileError("");
      setDecompileRetry(0);
      setActivePackageId(data.rootPackage);
      const root = data.packages.find((pkg) => pkg.id === data.rootPackage);
      setActiveModule(root?.modules[0]?.name ?? "");
      window.requestAnimationFrame(() =>
        document.getElementById("results")?.scrollIntoView({ behavior: "smooth" }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "分析失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  function useExample(value: string) {
    setPackageId(value);
    void analyze(undefined, value);
  }

  async function copyCode() {
    await navigator.clipboard.writeText(visibleCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function downloadCode() {
    if (!module) return;
    const blob = new Blob([visibleCode], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${module.name}.${activeTab === "source" ? "move" : "mv.disasm"}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main>
      <nav className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark"><Braces size={21} strokeWidth={2.3} /></span>
          <span>Sui<span>Scope</span></span>
        </a>
        <div className="nav-center">
          <a href="#analyzer">Analyzer</a>
          <a href="#features">Capabilities</a>
          <a href="https://docs.sui.io/" target="_blank" rel="noreferrer">Docs <ExternalLink size={12} /></a>
        </div>
        <a className="github-link" href="https://github.com/" target="_blank" rel="noreferrer">
          <GitFork size={17} /> GitHub
        </a>
      </nav>

      <section className="hero" id="analyzer">
        <div className="hero-grid" />
        <div className="hero-orb orb-one" />
        <div className="hero-orb orb-two" />
        <div className="hero-content">
          <div className="status-pill"><i /> SUI MOVE INTELLIGENCE</div>
          <h1>Read what the chain<br /><span>really executes.</span></h1>
          <p className="hero-subtitle">
            从 Package ID 出发，递归追踪依赖、还原 ABI，<br className="desktop-only" />
            并将链上 Move 字节码转换为可读源码。
          </p>

          <form className="search-shell" onSubmit={analyze}>
            <div className="network-select">
              <span className="network-dot" />
              <select
                value={network}
                onChange={(event) => setNetwork(event.target.value as Network)}
                aria-label="Sui network"
              >
                <option value="mainnet">MAINNET</option>
                <option value="testnet">TESTNET</option>
                <option value="devnet">DEVNET</option>
              </select>
              <ChevronDown size={14} />
            </div>
            <div className="search-divider" />
            <PackageSearch size={20} />
            <input
              value={packageId}
              onChange={(event) => setPackageId(event.target.value)}
              placeholder="0x…  输入 Sui Package ID"
              spellCheck={false}
              aria-label="Sui Package ID"
            />
            <button className="analyze-button" disabled={loading}>
              {loading ? <LoaderCircle className="spin" size={18} /> : <TerminalSquare size={18} />}
              {loading ? "Tracing…" : "Analyze"}
              {!loading && <ArrowRight size={16} />}
            </button>
          </form>

          <div className="examples">
            <span>TRY AN EXAMPLE</span>
            {EXAMPLES.map((example) => (
              <button key={example.value} onClick={() => useExample(example.value)}>
                {example.label} <code>{example.value}</code>
              </button>
            ))}
          </div>

          {error && (
            <div className="error-banner" role="alert">
              <CircleAlert size={17} />
              <span>{error}</span>
              <button onClick={() => setError("")}>×</button>
            </div>
          )}
        </div>
      </section>

      {loading && (
        <section className="loading-state">
          <div className="loader-rings"><span /><span /><Braces size={24} /></div>
          <span className="eyebrow">RESOLVING PACKAGE GRAPH</span>
          <h2>正在沿着链上依赖向下追踪</h2>
          <p>读取模块 ABI、反汇编字节码并重建可读签名…</p>
          <div className="loading-bar"><i /></div>
        </section>
      )}

      {!result && !loading && <EmptyPreview />}

      {result && (
        <section className="results" id="results">
          <div className="result-summary">
            <div className="summary-title">
              <span className="eyebrow"><Activity size={13} /> ANALYSIS COMPLETE</span>
              <h2>Package intelligence</h2>
              <div className="root-address">
                <code>{compactAddress(result.rootPackage, 12)}</code>
                <button onClick={() => navigator.clipboard.writeText(result.rootPackage)} title="复制地址"><Copy size={14} /></button>
                <a href={explorerUrl(result.network, result.rootPackage)} target="_blank" rel="noreferrer" title="在浏览器中查看"><ExternalLink size={14} /></a>
              </div>
            </div>
            <div className="stats-grid">
              <Stat icon={<Layers3 size={18} />} value={result.stats.packageCount} label="Packages" />
              <Stat icon={<Box size={18} />} value={result.stats.moduleCount} label="Modules" />
              <Stat icon={<Code2 size={18} />} value={result.stats.functionCount} label="Functions" />
              <Stat icon={<Clock3 size={18} />} value={formatTime(result.stats.elapsedMs)} label="Trace time" />
            </div>
          </div>

          {(result.warnings.length > 0 || result.stats.truncated) && (
            <div className="warning-strip">
              <CircleAlert size={16} />
              <span>
                {result.stats.truncated
                  ? "依赖超过 120 个，结果已安全截断。"
                  : result.warnings[0]}
              </span>
            </div>
          )}

          <div className="workspace">
            <DependencyPanel
              packages={result.packages}
              activeId={activePackageId}
              onSelect={(id) => {
                setActivePackageId(id);
                setFilter("");
              }}
            />

            <section className="module-panel">
              <div className="panel-heading module-heading">
                <div>
                  <span className="eyebrow">MODULES IN PACKAGE</span>
                  <h3>{activePackage?.depth === 0 ? "Root package" : activePackage?.shortId}</h3>
                </div>
                <a
                  href={activePackage ? explorerUrl(result.network, activePackage.id) : "#"}
                  target="_blank"
                  rel="noreferrer"
                >
                  Explorer <ExternalLink size={13} />
                </a>
              </div>
              <div className="module-search">
                <Search size={15} />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter modules"
                />
                <kbd>{filteredModules.length}</kbd>
              </div>
              <div className="module-list">
                {filteredModules.map((item) => (
                  <button
                    key={item.name}
                    className={module?.name === item.name ? "active" : ""}
                    onClick={() => setActiveModule(item.name)}
                  >
                    <span className="file-icon"><Braces size={14} /></span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.functionCount} fn · {item.structCount} struct</small>
                    </span>
                    <ArrowRight size={14} />
                  </button>
                ))}
                {!filteredModules.length && (
                  <div className="no-modules">没有匹配的模块</div>
                )}
              </div>
            </section>

            <section className="code-panel">
              <div className="code-toolbar">
                <div className="file-title">
                  <span className="file-icon"><Braces size={15} /></span>
                  <span><strong>{module?.name ?? "module"}</strong>.move</span>
                  <i className="verified">
                    <ShieldCheck size={13} />
                    {sourceMetadata?.verification.bytecodeVerified
                      ? "RUST VERIFIED"
                      : "ON-CHAIN"}
                  </i>
                </div>
                <div className="code-actions">
                  <button onClick={copyCode}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied" : "Copy"}</button>
                  <button onClick={downloadCode}><Download size={15} /> Download</button>
                </div>
              </div>
              <div className="code-tabs">
                <button
                  className={activeTab === "source" ? "active" : ""}
                  onClick={() => setActiveTab("source")}
                >
                  <Code2 size={14} /> Decompiled Move
                </button>
                <button
                  className={activeTab === "bytecode" ? "active" : ""}
                  onClick={() => setActiveTab("bytecode")}
                >
                  <GitBranch size={14} /> Bytecode IR
                </button>
                <span>
                  {fullSource ? "BYTECODE-DERIVED VIEW" : "ABI PREVIEW"}
                </span>
              </div>
              {activeTab === "source" && decompilingKey === sourceKey && (
                <div className="decompile-progress">
                  <LoaderCircle className="spin" size={14} />
                  正在还原 private/internal 函数与完整控制流…
                </div>
              )}
              {activeTab === "source" && decompileError && !fullSource && (
                <div className="decompile-error">
                  <CircleAlert size={14} />
                  <span>{decompileError}，当前显示 ABI 预览。</span>
                  <button
                    onClick={() => {
                      setDecompileError("");
                      setDecompileRetry((current) => current + 1);
                    }}
                  >
                    重试
                  </button>
                </div>
              )}
              {activeTab === "source" &&
                sourceMetadata?.verification &&
                sourceMetadata.verification.auditWarnings.length > 0 && (
                  <div className="decompile-error">
                    <CircleAlert size={14} />
                    <span>
                      反编译覆盖检查发现风险：
                      {sourceMetadata.verification.auditWarnings.join("；")}
                    </span>
                  </div>
                )}
              <SourceView code={visibleCode} />
              <div className="code-status">
                <span>
                  <i />{" "}
                  {sourceMetadata?.verification.knownInstructionCoverage &&
                  sourceMetadata.verification.controlFlowFullyStructured
                    ? "Rust · fail-closed coverage passed"
                    : fullSource
                      ? "Full decompile"
                      : "Sui Move"}
                </span>
                <span>
                  {sourceMetadata?.verification
                    ? `${sourceMetadata.verification.instructionCount} instructions · ${sourceMetadata.verification.abortCount} aborts`
                    : "UTF-8"}
                </span>
                <span className="status-right"><NetworkIcon size={13} /> {result.network}</span>
              </div>
            </section>
          </div>
        </section>
      )}

      <section className="features" id="features">
        <div className="feature-intro">
          <span className="eyebrow">BUILT FOR ON-CHAIN RESEARCH</span>
          <h2>没有源码仓库，也能从字节码开始。</h2>
        </div>
        <div className="feature-grid">
          <article>
            <span><GitBranch size={19} /></span>
            <h3>递归依赖追踪</h3>
            <p>从模块引用中提取直接与传递依赖，自动去重并标注依赖深度。</p>
          </article>
          <article>
            <span><Braces size={19} /></span>
            <h3>ABI 源码重建</h3>
            <p>还原结构体、能力、泛型约束、可见性、入口函数与完整类型签名。</p>
          </article>
          <article>
            <span><ShieldCheck size={19} /></span>
            <h3>链上指令核对</h3>
            <p>保留原始 Move bytecode IR，方便对照可读结果，不隐藏反编译边界。</p>
          </article>
        </div>
      </section>

      <footer>
        <a className="brand" href="#"><span className="brand-mark"><Braces size={18} /></span>Sui<span>Scope</span></a>
        <p>Chain data via Sui GraphQL & JSON-RPC · Source reconstruction is best-effort.</p>
        <span>Built for builders.</span>
      </footer>
    </main>
  );
}
