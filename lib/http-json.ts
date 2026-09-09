/** Read the body once; platform/proxy errors are often text or HTML, not JSON. */
export async function readJsonResponse<T>(response: Response, context: string): Promise<T> {
  const text = await response.text();
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    const hint = /FUNCTION_(?:RESPONSE_)?PAYLOAD_TOO_LARGE/.test(text) || response.status === 413
      ? "响应体超过平台大小限制，请使用分页分析"
      : /FUNCTION_INVOCATION_TIMEOUT|GATEWAY_TIMEOUT/.test(text) || [504, 408].includes(response.status)
        ? "服务执行超时，请重试当前请求"
        : "服务返回了非 JSON 响应（可能为平台或上游节点错误）";
    throw new Error(`${context}：${hint}，HTTP ${response.status}`);
  }
  if (!response.ok) {
    const error = value && typeof value === 'object' && 'error' in value ? value.error : null;
    throw new Error(`${context}：${typeof error === 'string' ? error.slice(0, 1000) : `HTTP ${response.status}`}`);
  }
  if (!value || typeof value !== 'object') throw new Error(`${context}：JSON 响应结构无效`);
  return value as T;
}

export async function postJsonResponse<T>(url: string, body: unknown, context: string,
  signal?: AbortSignal, timeoutMs = 25000): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal, cache: 'no-store' });
    return await readJsonResponse<T>(response, context);
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    if (controller.signal.aborted) throw new Error(`${context}：请求超过 ${timeoutMs / 1000} 秒，已停止等待，可重试`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
