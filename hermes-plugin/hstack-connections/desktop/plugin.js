import { host, useValue } from '@hermes/plugin-sdk'
import { useState, useEffect, useRef } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const services = [
  { id: 'buffer', name: 'Buffer', env: 'BUFFER_API_KEY', note: 'Account read tested previously; writes remain unverified.' },
  { id: 'pallyy', name: 'Pallyy', env: 'PALLYY_API_KEY', note: 'Validates with get_me. A real Pallyy account has not been tested here.' },
  { id: 'metricool', name: 'Metricool', env: 'METRICOOL_API_KEY', note: 'The API-key route requires eligible API access. Read tools remain blocked until reviewed.' },
  { id: 'blotato', name: 'Blotato', env: 'BLOTATO_API_KEY', note: 'Validates with blotato_get_user. Paid API/MCP access required; real-account testing pending.' },
  { id: 'ayrshare', name: 'Ayrshare', env: 'AYRSHARE_API_KEY', note: 'Validates with list_profiles, which requires eligible Business profile access. Real-account testing pending.' },
]

function Connections({ ctx }) {
  const profile = useValue(host.state.profile)
  const connectionId = useValue(host.state.connectionId ?? host.state.profile)
  const scope = `${connectionId}:${profile}`
  const formScope = useRef(scope)
  const [selected, setSelected] = useState('buffer')
  const [key, setKey] = useState('')
  const [state, setState] = useState('Checking saved key…')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('loading')
  const operation = useRef(0)
  const service = services.find(item => item.id === selected)
  async function act(action, secret) {
    const currentScope = `${(host.state.connectionId ?? host.state.profile).get()}:${host.state.profile.get()}`
    if (formScope.current !== currentScope) return
    const token = ++operation.current
    setBusy(true)
    try {
      const result = await ctx.rest(`/providers/${selected}`, { method: 'POST', body: secret === undefined ? { action } : { action, key: secret }, timeoutMs: 130000 })
      if (token !== operation.current) return
      setState(result.message)
      setStage(result.state)
      if (action === 'save') setKey('')
    } catch {
      if (token !== operation.current) return
      setStage('error')
      setState('Hstack backend unavailable. Enable its agent plugin, set HSTACK_DESKTOP_PROJECT_ROOT for the gateway, and restart the gateway.')
    } finally { if (token === operation.current) setBusy(false) }
  }
  useEffect(() => { formScope.current = scope; setKey(''); setStage('loading'); void act('status'); return () => { operation.current++ } }, [selected, scope])
  const button = (label, onClick, disabled = false) => jsx('button', {
    type: 'button', disabled: busy || disabled, onClick,
    style: { padding: '8px 12px', marginRight: 8, marginTop: 8, cursor: 'pointer' }, children: label,
  })
  return jsxs('section', { style: { padding: 20, maxWidth: 700, color: 'var(--ui-text-primary)' }, children: [
    jsx('h2', { children: 'Hstack Connections' }),
    jsx('p', { children: `Hermes profile: ${profile}` }),
    jsx('p', { children: 'Save a key, validate a read, activate it, then use a tool through Hermes.' }),
    jsx('label', { htmlFor: 'hstack-service', children: 'Service' }),
    jsx('select', { id: 'hstack-service', value: selected, disabled: busy,
      onChange: event => setSelected(event.target.value), style: { display: 'block', width: '100%', marginTop: 8, padding: 8 },
      children: services.map(item => jsx('option', { value: item.id, children: item.name }, item.id)) }),
    jsx('p', { children: service.note }),
    jsx('p', { children: 'The key is stored on this Hermes profile’s gateway host as an encrypted file by default. Its encryption key is held by macOS Keychain, or by the configured private master-key file on a headless gateway.' }),
    jsx('label', { htmlFor: 'hstack-service-key', children: `${service.name} API key` }),
    jsx('input', { id: 'hstack-service-key', type: 'password', value: key, autoComplete: 'off',
      onChange: event => setKey(event.target.value), style: { display: 'block', width: '100%', marginTop: 8, padding: 8 } }),
    button('1. Save key', () => void act('save', key), !key.trim()),
    button('2. Validate key', () => void act('test'), !['saved', 'verified', 'active', 'used', 'error', 'degraded'].includes(stage) || selected === 'metricool'),
    button('3. Activate in Hermes', () => void act('activate'), !['verified', 'active', 'used', 'degraded'].includes(stage)),
    button('4. Use read tool', () => void act('use'), !['active', 'used', 'degraded'].includes(stage)),
    button('Deactivate', () => void act('deactivate'), !['active', 'used', 'degraded', 'rate_limited'].includes(stage)),
    button('Refresh status', () => void act('status')),
    stage === 'migration_required' ? button('Encrypt existing key', () => void act('migrate')) : null,
    stage === 'reauth_required' ? jsx('p', {children: 'Create or obtain a replacement key in the service, paste it above, then save, validate and activate. API keys cannot be refreshed through OAuth.'}) : null,
    button('Remove saved key', () => void act('disconnect')),
    jsx('p', { role: 'status', 'aria-live': 'polite', children: state }),
    jsx('p', { children: 'Activation adds one Hstack Desktop MCP entry to this profile. New calls pick up key changes without a restart; a call already running may finish. Start a new chat after first activation. The read button uses Hermes’ native registry without an AI model. Environment keys and write permissions are excluded from this Desktop connection.' }),
    jsx('h3', { children: 'More services' }),
    jsx('p', { children: 'OAuth, database and other service setup screens are not available yet. Use the existing Hstack setup guides for those services.' }),
  ] })
}

export default {
  id: 'hstack-connections', name: 'Hstack Connections', defaultEnabled: false,
  register(ctx) {
    if (typeof ctx.registerSettingsPage === 'function') {
      ctx.registerSettingsPage({ id: 'connections', title: 'Hstack Connections', render: () => jsx(Connections, { ctx }) })
    } else {
      ctx.register({ id: 'connections', area: 'panes', title: 'Hstack Connections',
        data: { placement: 'right', width: '420px' }, render: () => jsx(Connections, { ctx }) })
    }
  },
}
