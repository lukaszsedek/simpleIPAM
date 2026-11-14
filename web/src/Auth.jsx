import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Field, Logo } from './ui.jsx';
import { t, useLang, setLang, getLang, LANGS } from './i18n.js';

const GOOGLE_MSG = { denied: 'Odmówiono dostępu na ekranie Google', state: 'Sesja logowania wygasła — spróbuj ponownie', error: 'Nie udało się zalogować przez Google' };

export function AuthScreen({ onAuth, registrationOpen = true, version = '', setup = false, google = false }) {
  useLang();
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ username: '', password: '', confirm: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {      // back from Google with an error (successful sign-in reloads straight into the app)
    const m = /[?&]google=([^&#]+)/.exec(location.search);
    if (!m) return;
    const v = decodeURIComponent(m[1]);
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
    setErr(v.startsWith('msg:') ? v.slice(4) : GOOGLE_MSG[v] ?? '');
  }, []);
  const viaGoogle = async () => {
    setErr(''); setBusy(true);
    try { location.href = (await api.googleStart(false)).url; } catch (e2) { setErr(e2.message); setBusy(false); }
  };
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if ((setup || mode === 'register') && f.password !== f.confirm) return setErr(t('Hasła nie są takie same'));
    setBusy(true);
    try {
      const r = await (mode === 'login' && !setup ? api.login : api.register)(f.username, f.password);
      onAuth(r.user, r.first);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };
  return (
    <div class="auth">
      <div class="lang-switch" role="group" aria-label={t('Język')}>
        {Object.entries(LANGS).map(([k, l]) => <button type="button" class={getLang() === k ? 'on' : ''} title={l} onClick={() => setLang(k)}>{k.toUpperCase()}</button>)}
      </div>
      <form class="auth-card" onSubmit={submit}>
        <div class="brand"><Logo size={28} />simpleIPAM</div>
        {setup && (
          <div class="setup-intro">
            <h1>{t('Witaj w simpleIPAM')}</h1>
            <p class="muted">{t('To pierwsze uruchomienie. Utwórz konto administratora — będzie mogło wszystko, w tym nadawać uprawnienia innym.')}</p>
          </div>
        )}
        {!setup && <div class="segmented">
          <button type="button" class={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>{t('Logowanie')}</button>
          {registrationOpen && <button type="button" class={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>{t('Rejestracja')}</button>}
        </div>}
        <Field label="Login"><input autofocus autocomplete="username" value={f.username} onInput={(e) => setF({ ...f, username: e.target.value })} required /></Field>
        <Field label="Hasło" hint={setup || mode === 'register' ? 'min. 8 znaków' : ''}>
          <input type="password" autocomplete={mode === 'login' && !setup ? 'current-password' : 'new-password'} value={f.password} onInput={(e) => setF({ ...f, password: e.target.value })} required /></Field>
        {(setup || mode === 'register') && <Field label="Powtórz hasło">
          <input type="password" autocomplete="new-password" value={f.confirm} onInput={(e) => setF({ ...f, confirm: e.target.value })} required /></Field>}
        {err && <p class="error-text" role="alert">{t(err)}</p>}
        <button class="btn primary block" disabled={busy}>{setup ? t('Utwórz konto administratora') : mode === 'login' ? t('Zaloguj') : t('Utwórz konto')}</button>
        {google && !setup && (
          <>
            <div class="or"><span>{t('lub')}</span></div>
            <button type="button" class="btn ghost block google-btn" disabled={busy} onClick={viaGoogle}>
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
              {t('Zaloguj przez Google')}
            </button>
          </>
        )}
        {!setup && mode === 'register' && <p class="muted small-text">{t('Nowe konto nie ma dostępu do żadnych danych (rola None), dopóki administrator nie nada uprawnień.')}</p>}
      </form>
      {version && <div class="auth-version">v{version.replace(/^v/, '')}</div>}
    </div>
  );
}
