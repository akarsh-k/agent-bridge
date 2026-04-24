import { useCallback, useEffect, useState } from 'react'
import { rpc } from './lib/rpc'
import './App.css'

export default function App() {
  const [health, setHealth] = useState<string>('…')
  const [hello, setHello] = useState<string>('…')
  const [echoIn, setEchoIn] = useState('typed RPC + Zod')
  const [echoOut, setEchoOut] = useState<string>('…')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await rpc.api.health.$get()
      if (cancelled) return
      if (!res.ok) {
        setHealth(`HTTP ${res.status}`)
        return
      }
      const data = await res.json()
      setHealth(data.ok ? 'ok' : 'unexpected')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const loadHello = useCallback(async () => {
    const res = await rpc.api.hello.$get({ query: { name: 'Agent Bridge' } })

    if (!res.ok) {
      setHello(`HTTP ${res.status}`)
      return
    }
    const data = await res.json()
    setHello(data.message)
  }, [])

  const sendEcho = useCallback(async () => {
    const res = await rpc.api.echo.$post({ json: { text: echoIn } })
    if (!res.ok) {
      setEchoOut(`HTTP ${res.status}`)
      return
    }
    const data = await res.json()
    setEchoOut(data.text)
  }, [echoIn])

  return (
    <main className="app">
      <h1>Agent Bridge</h1>
      <p className="lede">Hono RPC · Zod · React · Vite</p>

      <section className="card">
        <h2>Health</h2>
        <p>
          <code>/api/health</code> → <strong>{health}</strong>
        </p>
      </section>

      <section className="card">
        <h2>Hello (query)</h2>
        <p>{hello}</p>
        <button type="button" onClick={() => void loadHello()}>
          Call <code>hello</code>
        </button>
      </section>

      <section className="card">
        <h2>Echo (JSON)</h2>
        <input
          value={echoIn}
          onChange={(e) => setEchoIn(e.target.value)}
          aria-label="Echo text"
        />
        <button type="button" onClick={() => void sendEcho()}>
          POST <code>echo</code>
        </button>
        <p>
          Response: <strong>{echoOut}</strong>
        </p>
      </section>
    </main>
  )
}
