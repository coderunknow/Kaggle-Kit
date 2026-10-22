import { useEffect, useRef, useState } from 'react';

import { effectiveProfileTarget, resolveProfileCredential } from '../../shared/connection';
import type { ApiProfile } from '../../shared/domain';
import type { HttpToolSetting, McpServerSetting, ToolProfileSettings } from '../../shared/tools/types';
import { DEFAULT_TOOL_PROFILE_SETTINGS, HARD_TOOL_LIMITS } from '../../shared/tools/types';
import { httpModelName, mcpModelName } from '../../shared/tools/catalog';
import { applyCorePreset, CORE_PRESETS, grantKeylessCore } from '../../shared/tools/presets';
import { gateway } from '../lib/gateway';
import { createId } from '../lib/id';
import { useApp } from '../state/AppProvider';
import { Badge, Icon } from './ui';

const BUILTIN_GROUPS = [
  {
    label: 'Calculator',
    description: 'Deterministic arithmetic and unit conversion; no code evaluation.',
    tools: [
      ['calculator_calculate', 'Calculate an expression'],
      ['calculator_convert', 'Convert supported units'],
    ],
  },
  {
    label: 'Uploaded files',
    description: 'Read only files you select and upload to this conversation.',
    tools: [
      ['files_list', 'List conversation uploads'],
      ['files_read', 'Read bounded file excerpts'],
      ['files_analyze', 'Analyze a selected upload'],
    ],
  },
  {
    label: 'Public web',
    description: 'Retrieve a public page without Brave, or use Brave Search with a server-stored API key.',
    tools: [
      ['web_search', 'Brave Search (requires a provider key)'],
      ['web_open', 'Open a public HTTP(S) page'],
    ],
  },
  {
    label: 'Diagnostics',
    description: 'Read-only checks against the configured model endpoint.',
    tools: [['diagnostics_check', 'Check connectivity and model capabilities']],
  },
  {
    label: 'Python sandbox',
    description: 'Every run asks for approval. Docker is required; there is no host-code fallback.',
    tools: [['code_execute', 'Run Python in the isolated container']],
  },
] as const;

function cloneDefault(): ToolProfileSettings {
  return structuredClone(DEFAULT_TOOL_PROFILE_SETTINGS);
}

function toggle(items: string[], value: string, checked: boolean): string[] {
  return checked ? [...new Set([...items, value])] : items.filter((item) => item !== value);
}

function publicSettings(profile: ApiProfile): ToolProfileSettings {
  return structuredClone(profile.tools ?? cloneDefault());
}

function newHttpTool(endpoint: string, permission: HttpToolSetting['permission']): HttpToolSetting {
  const id = createId('http');
  return {
    id,
    name: 'Configured GET/HTTP request',
    description: 'Call a user-configured public HTTP endpoint with validated arguments.',
    endpoint,
    method: 'GET',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 400 } },
      required: [],
      additionalProperties: false,
    },
    headers: [],
    permission,
    timeoutMs: 10_000,
  };
}

function newMcpServer(name: string, url: string): McpServerSetting {
  return {
    id: createId('mcp'),
    name: name.trim().slice(0, 80) || 'MCP server',
    transport: 'streamable_http',
    enabled: false,
    confirmed: false,
    url: url.trim(),
    timeoutMs: 10_000,
    tools: [],
  };
}

export function ToolsSettings({ advanced = true }: { advanced?: boolean }) {
  const profile = useApp().activeProfile;
  if (!profile) {
    return (
      <div className="notice notice--info">
        <strong>No profile selected</strong>
        Select a connection profile before configuring tool permissions.
      </div>
    );
  }
  return <ProfileToolsSettings key={profile.id} profile={profile} advanced={advanced} />;
}

function ProfileToolsSettings({ profile, advanced }: { profile: ApiProfile; advanced: boolean }) {
  const app = useApp();
  const appRef = useRef(app);
  const profileId = profile.id;
  const [draft, setDraft] = useState<ToolProfileSettings>(() => publicSettings(profile));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [workingServer, setWorkingServer] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [braveKey, setBraveKey] = useState('');
  const [httpEndpoint, setHttpEndpoint] = useState('');
  const [httpToken, setHttpToken] = useState('');
  const [httpPermission, setHttpPermission] = useState<HttpToolSetting['permission']>('unknown');
  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpToken, setMcpToken] = useState('');

  useEffect(() => { appRef.current = app; }, [app]);

  useEffect(() => {
    let cancelled = false;
    void gateway.getToolProfile(profileId).then((stored) => {
      if (cancelled) return;
      if (stored) {
        setDraft(structuredClone(stored));
        const current = appRef.current.state.profiles.find((entry) => entry.id === profileId);
        if (current) appRef.current.saveProfile({ ...current, tools: stored });
      }
      setError(null);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Tool settings could not be read from the proxy.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [profileId]);

  const capability = app.state.capabilities[profile.id]?.toolCalling;
  const update = (changes: Partial<ToolProfileSettings>) => {
    setError(null);
    setMessage(null);
    setDraft((current) => ({ ...current, ...changes }));
  };

  const persist = async (settings = draft): Promise<ToolProfileSettings> => {
    setSaving(true);
    setError(null);
    try {
      const saved = await gateway.saveToolProfile(profile.id, settings);
      setDraft(structuredClone(saved));
      app.saveProfile({ ...profile, tools: saved, updatedAt: new Date().toISOString() });
      return saved;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    try {
      const settings = structuredClone(draft);
      if (braveKey.trim()) {
        const reference = settings.web.secretRef ?? createId('brave');
        await gateway.saveSecret(reference, braveKey.trim());
        settings.web = { ...settings.web, provider: 'brave', secretRef: reference };
      }
      const saved = await persist(settings);
      setBraveKey('');
      setMessage('Tool settings saved by the local proxy. Credentials remain in its secret store.');
      return saved;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tool settings could not be saved.');
      return null;
    }
  };

  const probe = async () => {
    setProbing(true);
    setError(null);
    setMessage(null);
    try {
      const credential = resolveProfileCredential(profile, app.state);
      const result = await gateway.probeToolCalling({
        baseUrl: effectiveProfileTarget(profile).baseUrl,
        model: profile.modelId || undefined,
        timeoutMs: profile.timeoutMs,
        ...credential,
      });
      app.dispatch({
        type: 'capabilities/set',
        profileId: profile.id,
        capabilities: {
          ...app.state.capabilities[profile.id],
          streamingVerified: app.state.capabilities[profile.id]?.streamingVerified ?? false,
          reasoningEffortSupported: app.state.capabilities[profile.id]?.reasoningEffortSupported ?? false,
          notes: app.state.capabilities[profile.id]?.notes ?? [],
          toolCalling: result,
        },
      });
      setMessage(result.detail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The native tool-calling probe failed.');
    } finally {
      setProbing(false);
    }
  };

  const addHttp = async () => {
    try {
      let setting = newHttpTool(httpEndpoint, httpPermission);
      if (httpToken.trim()) {
        const reference = createId('httpsecret');
        await gateway.saveSecret(reference, httpToken.trim());
        setting = { ...setting, headers: [{ name: 'Authorization', secretRef: reference }] };
      }
      const next = {
        ...draft,
        httpTools: [...draft.httpTools, setting].slice(0, 16),
        allowedTools: toggle(draft.allowedTools, httpModelName(setting.id), true),
      };
      setDraft(next);
      await persist(next);
      setHttpEndpoint('');
      setHttpToken('');
      setMessage('The configured HTTP tool was saved. It will be checked and executed only by the local proxy.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The HTTP tool could not be saved.');
    }
  };

  const addMcp = async () => {
    try {
      let server = newMcpServer(mcpName, mcpUrl);
      if (mcpToken.trim()) {
        const reference = createId('mcpsecret');
        await gateway.saveSecret(reference, mcpToken.trim());
        server = { ...server, headers: [{ name: 'Authorization', secretRef: reference }] };
      }
      const next = { ...draft, mcpServers: [...draft.mcpServers, server].slice(0, 8) };
      setDraft(next);
      await persist(next);
      setMcpName('');
      setMcpUrl('');
      setMcpToken('');
      setMessage('MCP connection saved but not granted. Discover tools, review their permissions, then explicitly grant access.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The MCP connection could not be saved.');
    }
  };

  const discoverMcp = async (serverId: string) => {
    setWorkingServer(serverId);
    setError(null);
    setMessage(null);
    try {
      const saved = await persist(draft);
      await gateway.discoverMcpTools(profile.id, serverId);
      const refreshed = await gateway.getToolProfile(profile.id);
      const next = refreshed ?? saved;
      setDraft(next);
      app.saveProfile({ ...profile, tools: next });
      setMessage('Tools discovered. Review the names and schemas, explicitly select only the ones you trust, then grant the connection.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'MCP discovery failed. No tool was executed.');
    } finally {
      setWorkingServer(null);
    }
  };

  const grantMcp = async (serverId: string) => {
    setWorkingServer(serverId);
    setError(null);
    setMessage(null);
    try {
      await persist(draft);
      const granted = await gateway.grantMcpServer(profile.id, serverId);
      setDraft(structuredClone(granted));
      app.saveProfile({ ...profile, tools: granted });
      setMessage('The MCP connection is granted. Only individually selected tools are offered to the model.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The MCP connection could not be granted.');
    } finally {
      setWorkingServer(null);
    }
  };

  const updateMcpTool = (serverId: string, serverToolName: string, changes: { selected?: boolean; permission?: 'read_only' | 'write' | 'unknown' }) => {
    const mcpServers = draft.mcpServers.map((server) => server.id !== serverId ? server : {
      ...server,
      tools: server.tools.map((tool) => tool.serverToolName !== serverToolName ? tool : { ...tool, ...changes }),
    });
    const server = mcpServers.find((item) => item.id === serverId);
    const tool = server?.tools.find((item) => item.serverToolName === serverToolName);
    if (server && tool) {
      const modelName = mcpModelName(server, serverToolName);
      setDraft({
        ...draft,
        mcpServers,
        allowedTools: toggle(draft.allowedTools, modelName, tool.selected),
      });
    }
  };

  return (
    <div className="settings-stack">
      <section className="card">
        <div className="row row--between">
          <div>
            <h3 className="card__title">Tool calling for {profile.name}</h3>
            <p className="card__description">
              Tools are disabled by default. Kaggle-Kit probes the exact endpoint and model with a harmless, isolated request; a URL or model family is never treated as proof.
            </p>
          </div>
          <Badge tone={capability?.status === 'supported_verified' ? 'ok' : capability?.status === 'unsupported' ? 'danger' : 'warning'}>
            {capability?.status ?? 'not verified'}
          </Badge>
        </div>
        <p className="field__hint" role="status">{capability?.detail ?? 'Run the native tool-call probe before enabling tools. Ordinary chat continues to work without tool support.'}</p>
        <div className="row">
          <button type="button" className="button button--small" onClick={() => void probe()} disabled={probing || loading}>
            <Icon name="refresh" size={13} />
            {probing ? 'Probing…' : 'Verify native tool calling'}
          </button>
          <label className="checkbox">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
            <span>Enable the server-side tool loop</span>
          </label>
        </div>
        {draft.enabled && capability?.status !== 'supported_verified' ? (
          <div className="notice notice--warning" role="status" style={{ marginTop: 12 }}>
            Tools are configured but will not be sent until this exact model and endpoint pass verification. Messages use ordinary chat instead.
          </div>
        ) : null}
      </section>

      <section className="card">
        <h3 className="card__title">Keyless built-in tools</h3>
        <p>Calculator, unit conversion, uploaded-file analysis, endpoint diagnostics and public page retrieval need no separate tool-provider key. Your model server may still require its own credential.</p>
        <p className="field__hint">Granting these read-only tools changes this profile’s permissions only after Save. It does not verify native tool calling, grant HTTP/MCP access, approve Python, or change execution limits.</p>
        <button type="button" className="button" disabled={loading || saving} onClick={() => update(grantKeylessCore(draft))}>Allow reviewed keyless built-ins</button>
        <label className="field">
          <span className="field__label">Narrow the current tool selection</span>
          <select defaultValue="" disabled={loading || saving} onChange={(event) => {
            const value = event.target.value as keyof typeof CORE_PRESETS;
            if (value in CORE_PRESETS) update(applyCorePreset(draft, value));
            event.target.value = '';
          }}>
            <option value="" disabled>Choose a preset (never adds permissions)</option>
            {Object.entries(CORE_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
          </select>
        </label>
        <p className="field__hint">If no tools are selected, use the reviewed grant above first. Presets never restore previously removed permissions.</p>
        <p role="status">{draft.allowedTools.length} tool(s) selected{draft.enabled ? '; loop enabled after saving and successful verification.' : '; chat only.'}</p>
        <div className="notice notice--warning">
          <strong>Search and Python readiness</strong>
          Keyless public-web search is not available in this build: no suitable public service could be verified. Opening a URL is not search. Optional Brave Search requires its own key in Advanced mode. Public services may block or rate-limit requests.
          Browser Python is not available. Optional digest-pinned Docker execution remains in Advanced mode and always requires approval.
        </div>
      </section>

      <section className="card" hidden={!advanced}>
        <h3 className="card__title">Available tool categories</h3>
        <p className="card__description">Only checked tools are exposed to the model. The server checks the allowlist again before every call.</p>
        {BUILTIN_GROUPS.map((group) => (
          <fieldset className="tool-settings__group" key={group.label}>
            <legend>{group.label}</legend>
            <p className="field__hint">{group.description}</p>
            {group.tools.map(([id, label]) => (
              <label className="checkbox" key={id}>
                <input type="checkbox" checked={draft.allowedTools.includes(id)} onChange={(event) => update({ allowedTools: toggle(draft.allowedTools, id, event.target.checked) })} />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
        ))}
        <label className="checkbox" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={draft.historyPersistence} onChange={(event) => update({ historyPersistence: event.target.checked })} />
          <span>
            Persist tool activity in browser conversation history
            <span className="field__hint" style={{ display: 'block' }}>Off by default. File contents and credentials are never persisted. Brave-derived answers remain session-only unless this setting is enabled and your plan permits retention (confirm that right below).</span>
          </span>
        </label>
        {draft.web.provider === 'brave' ? (
          <label className="checkbox" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={draft.web.storageRightsConfirmed === true} onChange={(event) => update({ web: { ...draft.web, storageRightsConfirmed: event.target.checked } })} />
            <span>I have verified that my Brave plan permits retaining result material.</span>
          </label>
        ) : null}
      </section>

      <section className="card" hidden={!advanced}>
        <h3 className="card__title">Web search provider</h3>
        <p className="card__description">Brave requires a subscribed API key. It is sent only to the local proxy secret store, never to a URL or browser storage.</p>
        <label className="field">
          <span className="field__label">Provider</span>
          <select value={draft.web.provider} onChange={(event) => update({ web: { ...draft.web, provider: event.target.value === 'brave' ? 'brave' : 'disabled' } })}>
            <option value="disabled">Disabled (public page opening only)</option>
            <option value="brave">Brave Search</option>
          </select>
        </label>
        {draft.web.provider === 'brave' ? (
          <label className="field">
            <span className="field__label">Brave Search API key</span>
            <input type="password" autoComplete="new-password" value={braveKey} onChange={(event) => setBraveKey(event.target.value)} placeholder={draft.web.secretRef ? 'Key stored by the proxy; leave blank to keep it' : 'Enter the provider key'} />
            <span className="field__hint">Secret reference: {draft.web.secretRef ? 'configured' : 'not configured'}.</span>
          </label>
        ) : null}
      </section>

      <section className="card" hidden={!advanced}>
        <h3 className="card__title">Bounded execution</h3>
        <p className="card__description">Server-enforced budgets. Conversation settings may only tighten these limits.</p>
        <div className="tool-settings__limits">
          {([
            ['maxRounds', 'Maximum model rounds', HARD_TOOL_LIMITS.maxRounds],
            ['maxCalls', 'Maximum tool calls', HARD_TOOL_LIMITS.maxCalls],
            ['perToolTimeoutMs', 'Per-tool timeout (ms)', HARD_TOOL_LIMITS.perToolTimeoutMs],
            ['loopTimeoutMs', 'Whole-loop timeout (ms)', HARD_TOOL_LIMITS.loopTimeoutMs],
            ['maxInputBytes', 'Maximum tool input (bytes)', HARD_TOOL_LIMITS.maxInputBytes],
            ['maxOutputBytes', 'Maximum output (bytes)', HARD_TOOL_LIMITS.maxOutputBytes],
          ] as const).map(([key, label, maximum]) => (
            <label className="field" key={key}>
              <span className="field__label">{label}</span>
              <input type="number" min={1} max={maximum} value={draft.limits[key]} onChange={(event) => {
                const value = Number(event.target.value);
                update({ limits: { ...draft.limits, [key]: Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : draft.limits[key] } });
              }} />
            </label>
          ))}
        </div>
      </section>

      <section className="card" hidden={!advanced}>
        <h3 className="card__title">Configured HTTP tools</h3>
        <p className="card__description">Requests are pinned to public DNS results, limited to ports 80/443, bounded, and never follow redirects. Non-GET actions and unknown permissions pause for approval.</p>
        {draft.httpTools.map((tool) => (
          <div className="tool-settings__entry" key={tool.id}>
            <div className="row row--between">
              <strong>{tool.name}</strong>
              <button type="button" className="button button--small button--danger" onClick={() => update({ httpTools: draft.httpTools.filter((item) => item.id !== tool.id), allowedTools: draft.allowedTools.filter((id) => id !== httpModelName(tool.id)) })}>Remove</button>
            </div>
            <code className="tool-settings__url">{tool.method} {tool.endpoint}</code>
            <label className="checkbox">
              <input type="checkbox" checked={draft.allowedTools.includes(httpModelName(tool.id))} onChange={(event) => update({ allowedTools: toggle(draft.allowedTools, httpModelName(tool.id), event.target.checked) })} />
              <span>Offer this tool to the model</span>
            </label>
            <label className="field">
              <span className="field__label">Permission classification</span>
              <select value={tool.permission} onChange={(event) => update({ httpTools: draft.httpTools.map((item) => item.id === tool.id ? { ...item, permission: event.target.value as HttpToolSetting['permission'] } : item) })}>
                <option value="unknown">Unknown (approval required)</option>
                <option value="read_only">Read-only (may run automatically)</option>
                <option value="write">Write (approval required)</option>
              </select>
            </label>
          </div>
        ))}
        {draft.httpTools.length === 0 ? <p className="text-subtle">No custom HTTP tools configured.</p> : null}
        <label className="field">
          <span className="field__label">Public endpoint URL</span>
          <input type="url" value={httpEndpoint} onChange={(event) => setHttpEndpoint(event.target.value)} placeholder="https://api.example.com/search" />
        </label>
        <label className="field">
          <span className="field__label">Permission for this endpoint</span>
          <select value={httpPermission} onChange={(event) => setHttpPermission(event.target.value as HttpToolSetting['permission'])}>
            <option value="unknown">Unknown (approval required)</option>
            <option value="read_only">Read-only (may run automatically)</option>
            <option value="write">Write (approval required)</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Optional Authorization header value</span>
          <input type="password" autoComplete="new-password" value={httpToken} onChange={(event) => setHttpToken(event.target.value)} placeholder="Stored as a server-side secret reference" />
        </label>
        <button type="button" className="button button--small" disabled={!/^https:\/\//i.test(httpEndpoint) || draft.httpTools.length >= 16 || saving} onClick={() => void addHttp()}>
          <Icon name="plus" size={13} /> Add HTTP tool
        </button>
      </section>

      <section className="card" hidden={!advanced}>
        <h3 className="card__title">Remote MCP connections</h3>
        <p className="card__description">Only public HTTPS Streamable HTTP connections are supported here. Discovery does not grant access. Each connection requires a separate explicit grant; individual tools remain off until selected. Local stdio is disabled.</p>
        {draft.mcpServers.map((server) => (
          <div className="tool-settings__entry" key={server.id}>
            <div className="row row--between">
              <strong>{server.name}</strong>
              <Badge tone={server.confirmed && server.enabled ? 'ok' : 'warning'}>{server.confirmed && server.enabled ? 'granted' : 'not granted'}</Badge>
            </div>
            <code className="tool-settings__url">{server.url}</code>
            {server.tools.length === 0 ? <p className="text-subtle">No tools discovered yet.</p> : server.tools.map((tool) => {
              const modelName = mcpModelName(server, tool.serverToolName);
              return (
                <div className="tool-settings__mcp-tool" key={tool.serverToolName}>
                  <label className="checkbox">
                    <input type="checkbox" checked={tool.selected} onChange={(event) => updateMcpTool(server.id, tool.serverToolName, { selected: event.target.checked })} />
                    <span><strong>{tool.name}</strong><span className="field__hint" style={{ display: 'block' }}>{tool.description || 'No description supplied.'}</span></span>
                  </label>
                  <code>{modelName}</code>
                  <label className="field">
                    <span className="field__label">Permission for this tool</span>
                    <select value={tool.permission} onChange={(event) => updateMcpTool(server.id, tool.serverToolName, { permission: event.target.value === 'read_only' ? 'read_only' : event.target.value === 'write' ? 'write' : 'unknown' })}>
                      <option value="unknown">Unknown (approval required)</option>
                      <option value="read_only">Read-only (may run automatically)</option>
                      <option value="write">Write (approval required)</option>
                    </select>
                  </label>
                </div>
              );
            })}
            <div className="row">
              <button type="button" className="button button--small" disabled={workingServer !== null || saving} onClick={() => void discoverMcp(server.id)}>
                {workingServer === server.id ? 'Working…' : 'Discover tools'}
              </button>
              <button type="button" className="button button--small button--primary" disabled={workingServer !== null || saving || server.tools.length === 0 || !server.tools.some((tool) => tool.selected)} onClick={() => void grantMcp(server.id)}>
                Explicitly grant selected tools
              </button>
              <button type="button" className="button button--small button--danger" onClick={() => update({ mcpServers: draft.mcpServers.filter((item) => item.id !== server.id), allowedTools: draft.allowedTools.filter((name) => !server.tools.some((tool) => mcpModelName(server, tool.serverToolName) === name)) })}>Remove
              </button>
            </div>
          </div>
        ))}
        <label className="field">
          <span className="field__label">Connection name</span>
          <input type="text" value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="Research tools" />
        </label>
        <label className="field">
          <span className="field__label">Public HTTPS MCP endpoint</span>
          <input type="url" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" />
        </label>
        <label className="field">
          <span className="field__label">Optional Authorization value for this new connection</span>
          <input type="password" autoComplete="new-password" value={mcpToken} onChange={(event) => setMcpToken(event.target.value)} placeholder="Stored as a server-side secret reference" />
        </label>
        <button type="button" className="button button--small" disabled={!/^https:\/\//i.test(mcpUrl) || draft.mcpServers.length >= 8 || saving} onClick={() => void addMcp()}>
          <Icon name="plus" size={13} /> Add MCP connection
        </button>
      </section>

      <section className="card" hidden={!advanced}>
        <h3 className="card__title">Code execution sandbox</h3>
        <p className="card__description">Host execution is never used. Every Python run requires approval, and Docker must already have the digest-pinned Python Alpine image; the proxy does not pull it automatically.</p>
        <label className="field">
          <span className="field__label">Locally available, digest-pinned image</span>
          <input type="text" value={draft.code.image} onChange={(event) => {
            const image = event.target.value.trim();
            const pinned = /^python:3\.(?:11|12|13)-alpine@sha256:[a-f0-9]{64}$/.test(image);
            update({ code: { ...draft.code, image, provider: pinned ? 'docker' : 'disabled' } });
          }} placeholder="python:3.12-alpine@sha256:<64 lowercase hex characters>" />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={draft.allowedTools.includes('code_execute')} disabled={draft.code.provider !== 'docker'} onChange={(event) => update({ allowedTools: toggle(draft.allowedTools, 'code_execute', event.target.checked) })} />
          <span>Allow the model to request Python execution (each run requires approval)</span>
        </label>
        <p className="field__hint">Provider: {draft.code.provider === 'docker' ? 'Docker is configured; verify it is installed and the exact image digest is already present.' : 'disabled until a supported image digest is entered'}.</p>
        <p className="field__hint">Read-only root filesystem, no network, dropped capabilities, no-new-privileges, and bounded CPU/memory/processes/output. No host fallback exists.</p>
        <div className="tool-settings__limits">
          {([
            ['timeoutMs', 'Run timeout (ms)', 1_000, 60_000, 1],
            ['memoryMb', 'Memory limit (MiB)', 64, 2_048, 1],
            ['cpuCores', 'CPU limit (cores)', 0.1, 2, 0.1],
            ['maxProcesses', 'Process limit', 1, 128, 1],
            ['outputBytes', 'Output limit (bytes)', 256, 32_768, 1],
          ] as const).map(([key, label, minimum, maximum, step]) => (
            <label className="field" key={key}>
              <span className="field__label">{label}</span>
              <input
                type="number"
                min={minimum}
                max={maximum}
                step={step}
                value={draft.code[key]}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  const bounded = Math.max(minimum, Math.min(maximum, step === 1 ? Math.floor(value) : Math.round(value * 10) / 10));
                  update({ code: { ...draft.code, [key]: bounded } });
                }}
              />
              <span className="field__hint">Allowed range {minimum}–{maximum}; the server enforces the same bounds.</span>
            </label>
          ))}
        </div>
        <p className="field__hint">Isolation is fixed to the strict mode the Docker backend enforces (network: none, read-only root, unprivileged user, tmpfs workspace). Weaker modes are not offered because the backend cannot enforce them safely.</p>
      </section>

      {loading ? <p className="text-subtle" role="status">Loading settings from the local proxy…</p> : null}
      {error ? <div className="notice notice--warning" role="alert">{error}</div> : null}
      {message ? <div className="notice notice--info" role="status">{message}</div> : null}
      <div className="row settings-actions">
        <button type="button" className="button button--primary" onClick={() => void save()} disabled={saving || loading}>
          <Icon name="check" size={13} /> {saving ? 'Saving…' : 'Save tool settings'}
        </button>
      </div>
    </div>
  );
}
