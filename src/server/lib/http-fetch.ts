import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export interface GuardedFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface GuardedResponse {
  status: number;
  url: string;
  headers: Headers;
  body: Buffer;
  text(): string;
}

export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function requireOk(res: GuardedResponse, what?: string): GuardedResponse {
  if (res.status !== 200) throw new HttpStatusError(res.status, what ? `HTTP ${res.status} for ${what}` : `HTTP ${res.status}`);
  return res;
}

let proxyAgent: ProxyAgent | null = null;
function getDispatcher(urlStr: string): Dispatcher | undefined {
  const proxyUrl = process.env.EGRESS_PROXY_URL?.trim();
  if (!proxyUrl) return undefined;
  const host = new URL(urlStr).hostname.toLowerCase();
  // Domestic .cn sources connect directly; external hosts use proxy if configured
  if (host.endsWith(".cn") || host === "localhost" || host === "127.0.0.1") return undefined;
  proxyAgent ??= new ProxyAgent(proxyUrl);
  return proxyAgent;
}

export async function guardedFetch(input: string, opts: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const headers = new Headers({
    "user-agent": "Mozilla/5.0 (compatible; MyMarkets/1.0)",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  });
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    headers.set(name, value);
  }

  const res = await undiciFetch(input, {
    method: (opts.method ?? "GET").toUpperCase(),
    headers: Object.fromEntries(headers),
    body: opts.body,
    dispatcher: getDispatcher(input),
    signal,
  });

  const chunks: Buffer[] = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (size + chunk.byteLength > maxBytes) {
        throw new Error(`Response too large from ${new URL(input).hostname}`);
      }
      size += chunk.byteLength;
      chunks.push(Buffer.from(chunk));
    }
  }
  const body = Buffer.concat(chunks);
  return {
    status: res.status,
    url: res.url || input,
    headers: res.headers as unknown as Headers,
    body,
    text: () => decodeBody(body, res.headers.get("content-type")),
  };
}

function decodeBody(body: Buffer, contentType: string | null): string {
  const m = /charset="?([\w-]+)/i.exec(contentType ?? "");
  let charset = m?.[1]?.toLowerCase() ?? "utf-8";
  if (!m) {
    const head = body.subarray(0, 2048).toString("latin1");
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ?? /encoding=["']([\w-]+)["']/i.exec(head);
    if (meta) charset = meta[1]!.toLowerCase();
  }
  let text: string;
  try {
    text = new TextDecoder(charset === "gb2312" ? "gbk" : charset).decode(body);
  } catch {
    text = body.toString("utf8");
  }
  return text.replace(/\u0000/g, "\uFFFD").replace(/\uFFFD+/g, "\uFFFD");
}
