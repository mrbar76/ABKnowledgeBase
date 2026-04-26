// Minimal MCP (Model Context Protocol) HTTP client.
// Speaks the Streamable HTTP transport against a remote MCP server.
// Dependency-free (uses global fetch from Node 18+).
//
// Usage:
//   const client = new McpClient({ url, headers });
//   await client.initialize();
//   const { tools } = await client.listTools();
//   const result = await client.callTool('gmail_search', { q: '...' });

const PROTOCOL_VERSION = '2025-06-18';

class McpClient {
  constructor({ url, headers = {}, clientName = 'ab-brain', clientVersion = '0.1.0' }) {
    if (!url) throw new Error('McpClient: url is required');
    this.url = url;
    this.extraHeaders = headers;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.sessionId = null;
    this.nextId = 1;
    this.serverCapabilities = null;
  }

  _buildHeaders(extra = {}) {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...this.extraHeaders,
      ...extra,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async _rpc(method, params = undefined) {
    const id = this.nextId++;
    const body = { jsonrpc: '2.0', id, method };
    if (params !== undefined) body.params = params;

    const res = await fetch(this.url, {
      method: 'POST',
      headers: this._buildHeaders(),
      body: JSON.stringify(body),
    });

    // Capture session id if the server assigns one (typically on initialize)
    const newSession = res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id');
    if (newSession && !this.sessionId) this.sessionId = newSession;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP ${method} failed: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 500)}`);
    }

    const contentType = res.headers.get('content-type') || '';
    let payload;
    if (contentType.includes('text/event-stream')) {
      payload = await this._readSseResponse(res, id);
    } else {
      payload = await res.json();
    }

    if (payload.error) {
      const err = payload.error;
      throw new Error(`MCP ${method} returned error ${err.code}: ${err.message}`);
    }
    return payload.result;
  }

  // Reads an SSE stream and returns the first JSON-RPC response matching `id`.
  async _readSseResponse(res, id) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.id === id) return parsed;
          } catch { /* skip non-JSON SSE data lines */ }
        }
      }
    }
    throw new Error('MCP SSE stream ended without a matching response');
  }

  async initialize() {
    const result = await this._rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    });
    this.serverCapabilities = result?.capabilities || {};
    // Per MCP spec, client should send `notifications/initialized` after init
    await this._notify('notifications/initialized');
    return result;
  }

  async _notify(method, params = undefined) {
    const body = { jsonrpc: '2.0', method };
    if (params !== undefined) body.params = params;
    // Notifications have no `id` and expect no response body
    await fetch(this.url, {
      method: 'POST',
      headers: this._buildHeaders(),
      body: JSON.stringify(body),
    }).catch(() => { /* notifications are best-effort */ });
  }

  async listTools() {
    return this._rpc('tools/list');
  }

  async callTool(name, args = {}) {
    return this._rpc('tools/call', { name, arguments: args });
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, { method: 'DELETE', headers: this._buildHeaders() });
    } catch { /* best-effort */ }
    this.sessionId = null;
  }
}

module.exports = { McpClient };
