import { useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Field } from './ui.jsx';

export function AuthScreen({ onAuth, registrationOpen = true }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ username: '', password: '', confirm: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (mode === 'register' && f.password !== f.confirm) return setErr('Hasła nie są takie same');
    setBusy(true);
    try {
      const r = await (mode === 'login' ? api.login : api.register)(f.username, f.password);
      onAuth(r.user, r.first);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };
  return (
    <div class="auth">
      <form class="auth-card" onSubmit={submit}>
        <div class="brand"><span class="logo"><Icon name="plus" size={16} /></span>simpleIPAM</div>
        <div class="segmented">
          <button type="button" class={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>Logowanie</button>
          {registrationOpen && <button type="button" class={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>Rejestracja</button>}
        </div>
        <Field label="Login"><input autofocus autocomplete="username" value={f.username} onInput={(e) => setF({ ...f, username: e.target.value })} required /></Field>
        <Field label="Hasło" hint={mode === 'register' ? 'min. 8 znaków' : ''}>
          <input type="password" autocomplete={mode === 'login' ? 'current-password' : 'new-password'} value={f.password} onInput={(e) => setF({ ...f, password: e.target.value })} required /></Field>
        {mode === 'register' && <Field label="Powtórz hasło">
          <input type="password" autocomplete="new-password" value={f.confirm} onInput={(e) => setF({ ...f, confirm: e.target.value })} required /></Field>}
        {err && <p class="error-text" role="alert">{err}</p>}
        <button class="btn primary block" disabled={busy}>{mode === 'login' ? 'Zaloguj' : 'Utwórz konto'}</button>
        {mode === 'register' && <p class="muted small-text">Pierwsze konto w systemie zostaje administratorem. Kolejne konta nie mają dostępu, dopóki admin nie nada uprawnień.</p>}
      </form>
    </div>
  );
}
