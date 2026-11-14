import { useEffect, useState } from 'preact/hooks';
import { api } from './api.js';
import { Icon, Field, Modal } from './ui.jsx';

const bytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
const when = (iso) => new Date(iso).toLocaleString('pl-PL');
const PROVIDERS = [['none', 'Tylko lokalnie'], ['s3', 'Amazon S3 / zgodne'], ['gcs', 'Google Cloud Storage'], ['gdrive', 'Dysk Google']];

const ROWS = [['tenants', 'Tenanty'], ['sites', 'Lokalizacje'], ['networks', 'Sieci'], ['entries', 'Wpisy'], ['users', 'Użytkownicy']];

function RestoreModal({ preview, onClose, notify }) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const { current, backup } = preview;
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.applyRestore(preview.token);
      notify('Przywrócono. Zaloguj się ponownie.');
      setTimeout(() => { location.hash = '#/'; location.reload(); }, 900);
      return r;
    } catch (e) { notify(e.message, 'error'); setBusy(false); }
  };
  return (
    <Modal title="Przywróć kopię zapasową" onClose={onClose} wide>
      <p class="muted small-text">Źródło: <b class="mono">{preview.label}</b></p>
      <table class="compare">
        <thead><tr><th /><th>Teraz</th><th /><th>Po przywróceniu</th></tr></thead>
        <tbody>
          {ROWS.map(([k, l]) => (
            <tr class={current[k] !== backup[k] ? 'changed' : ''}><td>{l}</td><td>{current[k]}</td><td class="arrow">→</td><td>{backup[k]}</td></tr>
          ))}
        </tbody>
      </table>
      <div class="warnings">
        <div class="warn danger">Wszystkie bieżące dane (sieci, wpisy, użytkownicy, role, tokeny API, ustawienia kopii) zostaną <b>zastąpione</b> zawartością kopii. Wszyscy użytkownicy zostaną wylogowani.</div>
        {backup.admins === 0 && <div class="warn danger">Ta kopia <b>nie zawiera globalnego administratora</b>. Po przywróceniu zaloguj się kontem z kopii albo ustaw administratora poleceniem <span class="mono">node src/cli.js reset-admin &lt;login&gt;</span>.</div>}
        {!preview.you_in_backup && <div class="warn">Twojego konta nie ma w tej kopii. Po przywróceniu zalogujesz się kontem z kopii (np. {backup.usernames.slice(0, 3).join(', ') || '—'}).</div>}
        {preview.migrated && <div class="warn">Kopia pochodzi ze starszej wersji aplikacji — zostanie zaktualizowana do obecnego schematu (dotychczasowe lokalizacje trafią do tenanta „Domyślny”).</div>}
        <div class="warn info">Tuż przed przywróceniem zapiszemy kopię bezpieczeństwa obecnego stanu. Znajdziesz ją na liście kopii i będziesz mógł ją przywrócić, żeby cofnąć zmianę.</div>
      </div>
      <label class="toggle confirm"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Rozumiem, że obecne dane zostaną zastąpione</label>
      <footer class="modal-actions">
        <button class="btn ghost" onClick={onClose}>Anuluj</button>
        <button class="btn danger-solid" disabled={!ok || busy} onClick={apply}>{busy ? 'Przywracam…' : 'Przywróć'}</button>
      </footer>
    </Modal>
  );
}

function LastRun({ last }) {
  if (!last) return <p class="muted small-text">Jeszcze nie wykonano żadnej kopii.</p>;
  const part = (label, r) => r && <span class={`chip ${r.ok ? 'ok' : 'bad'}`}>{label}: {r.ok ? 'OK' : 'błąd'}</span>;
  return (
    <div class={`last-run ${last.ok ? 'ok' : 'bad'}`}>
      <div><b>{last.ok ? 'Ostatnia kopia' : 'Ostatnia kopia zakończyła się błędem'}</b> · {when(last.at)} · {last.trigger === 'auto' ? 'automatyczna' : 'ręczna'} · {bytes(last.size)}</div>
      <div class="chips">{part('serwer', last.local)}{part({ gcs: 'GCS', gdrive: 'Dysk Google' }[last.remote?.provider] ?? 'S3', last.remote)}</div>
      {[last.local, last.remote].filter((r) => r && !r.ok).map((r) => <div class="error-text small-text">{r.message}</div>)}
    </div>
  );
}

function PassphraseModal({ retry, busy, onSubmit, onClose }) {
  const [p, setP] = useState('');
  return (
    <Modal title="Kopia jest zaszyfrowana" onClose={onClose}>
      <form class="form-grid" onSubmit={(e) => { e.preventDefault(); onSubmit(p); }}>
        <Field label="Hasło szyfrowania" span hint={retry ? 'Nieprawidłowe hasło — spróbuj ponownie' : 'To samo, którym zaszyfrowano kopię'}>
          <input type="password" autofocus autocomplete="off" value={p} onInput={(e) => setP(e.target.value)} required /></Field>
        <footer><button type="button" class="btn ghost" onClick={onClose}>Anuluj</button><button class="btn primary" disabled={busy}>Odszyfruj</button></footer>
      </form>
    </Modal>
  );
}

export function Backups({ notify }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const load = () => api.backups().then((d) => { setData(d); setForm((f) => f ?? seed(d.config)); }).catch((e) => notify(e.message, 'error'));
  const [drive, setDrive] = useState(null);   // backups found in Google Drive: null = not loaded, [] = none
  const [device, setDevice] = useState(null);   // { user_code, verification_url } while waiting for the user at google.com/device
  useEffect(() => {
    load();
    const m = /[?&]gdrive=(\w+)/.exec(location.hash);      // back from Google's consent screen
    if (m) {
      history.replaceState(null, '', '#/admin/backups');
      const msg = { ok: ['Dysk Google połączony', 'ok'], denied: ['Odmówiono dostępu na ekranie Google', 'error'], state: ['Sesja logowania wygasła — spróbuj ponownie', 'error'], error: ['Nie udało się połączyć z Google — sprawdź Client ID/Secret i adres przekierowania', 'error'] }[m[1]];
      if (msg) notify(...msg);
    }
  }, []);
  useEffect(() => {      // poll while the device code is shown
    if (!device) return undefined;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await api.gdriveDevicePoll();
        if (stop) return;
        if (r.status === 'connected') { setDevice(null); await load(); notify('Dysk Google połączony'); return; }
        if (r.status === 'denied' || r.status === 'expired') { setDevice(null); notify(r.status === 'denied' ? 'Odmówiono dostępu' : 'Kod wygasł — wygeneruj nowy', 'error'); return; }
      } catch (e) { setDevice(null); notify(e.message, 'error'); return; }
      timer = setTimeout(tick, device.interval * 1000);
    };
    let timer = setTimeout(tick, device.interval * 1000);
    return () => { stop = true; clearTimeout(timer); };
  }, [device]);
  // secret inputs start empty: a blank value on save means "keep the stored secret"
  const seed = (c) => ({ provider: c.provider, remote_enabled: c.remote_enabled, local_keep: c.local_keep,
    s3: { ...c.s3, secret_key: '' }, gcs: { ...c.gcs, service_account_json: '' }, gdrive: { ...c.gdrive, client_secret: '' }, encrypt: { enabled: c.encrypt.enabled, passphrase: '' } });

  if (!data || !form) return <p class="muted">Ładowanie…</p>;
  const cfg = data.config;
  const set = (path, v) => setForm((f) => (path.length === 1 ? { ...f, [path[0]]: v } : { ...f, [path[0]]: { ...f[path[0]], [path[1]]: v } }));

  const act = async (name, fn, ok) => {
    setBusy(name);
    try { const r = await fn(); if (ok) ok(r); } catch (e) { notify(e.message, 'error'); }
    setBusy('');
  };
  const save = () => act('save', async () => {
    const saved = await api.saveBackupConfig(form);
    setForm(seed(saved));
    await load();
    notify('Zapisano ustawienia kopii');
  });
  const runNow = () => act('run', api.runBackup, async (r) => { await load(); notify(r.ok ? `Kopia wykonana: ${r.name}` : 'Kopia wykonana z błędami — zobacz szczegóły', r.ok ? 'ok' : 'error'); });
  const test = () => act('test', async () => {
    setForm(seed(await api.saveBackupConfig(form)));       // test exactly what is on screen
    return api.testRemote();
  }, (r) => notify(r.ok ? 'Połączenie działa — plik testowy został wysłany' : `Błąd połączenia: ${r.message}`, r.ok ? 'ok' : 'error'));
  const del = (name) => confirm(`Usunąć kopię ${name}?`) && act('del', () => api.delBackup(name), load);
  const [askPass, setAskPass] = useState(null);   // { fn(passphrase) } while the user is asked for an encryption passphrase
  const inspect = async (fn, pass) => {
    setBusy('inspect');
    try { setPreview(await fn(pass)); setAskPass(null); }
    catch (e) {
      if (/zaszyfrowana|Nieprawidłowe hasło/.test(e.message)) setAskPass({ fn, retry: !!pass }); else notify(e.message, 'error');
    }
    setBusy('');
  };
  const pickFile = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) inspect((p) => api.inspectUpload(f, p)); };
  // Saves what is on screen first (Client ID/Secret), then starts the chosen sign-in flow.
  const connect = () => act('connect', async () => { setForm(seed(await api.saveBackupConfig(form))); return api.gdriveConnect(); }, (r) => { location.href = r.url; });
  const connectDevice = () => act('connect', async () => { setForm(seed(await api.saveBackupConfig(form))); return api.gdriveDeviceStart(); }, setDevice);
  const disconnect = () => confirm('Odłączyć konto Google? Aplikacja straci dostęp do Dysku.') && act('connect', api.gdriveDisconnect, async () => { await load(); setForm(seed((await api.backups()).config)); });
  const loadDrive = () => act('drive', api.gdriveFiles, (r) => setDrive(r.files));
  const readKey = async (e) => { const f = e.target.files[0]; if (f) set(['gcs', 'service_account_json'], await f.text()); e.target.value = ''; };

  return (
    <div class="admin-grid">
      {askPass && <PassphraseModal retry={askPass.retry} busy={busy === 'inspect'} onSubmit={(p) => inspect(askPass.fn, p)} onClose={() => setAskPass(null)} />}
      {preview && <RestoreModal preview={preview} notify={notify} onClose={() => setPreview(null)} />}
      <section class="card">
        <h3>Pobierz kopię</h3>
        <p class="muted small-text">Spójna migawka całej bazy (plik SQLite) tworzona w chwili kliknięcia. Nic nie jest zapisywane na serwerze.</p>
        <a class="btn primary" href="/api/admin/backup"><Icon name="download" />Pobierz teraz</a>
      </section>

      <section class="card span-2">
        <div class="card-head">
          <h3>Kopie na serwerze i w chmurze</h3>
          <label class="btn ghost" title="Przywróć z pliku .db pobranego wcześniej lub z chmury">
            <Icon name="upload" />Przywróć z pliku<input type="file" accept=".db,.enc,.sqlite,application/octet-stream" hidden onChange={pickFile} />
          </label>
          <button class="btn primary" disabled={busy === 'run'} onClick={runNow}><Icon name="cloud2" />{busy === 'run' ? 'Wykonuję…' : 'Wykonaj kopię teraz'}</button>
        </div>
        <LastRun last={data.last} />
        <p class="muted small-text">Raz dziennie aplikacja sama wykonuje kopię: zapisuje ją lokalnie{cfg.remote_enabled ? ' i wysyła do chmury' : ''}.</p>
        {data.dir_enabled ? (
          <div class="table-wrap flush">
            <table>
              <thead><tr><th>Plik</th><th>Utworzono</th><th>Rozmiar</th><th /></tr></thead>
              <tbody>
                {data.files.map((f) => (
                  <tr>
                    <td class="mono">{f.name.endsWith('.enc') && <span title="zaszyfrowana">🔒 </span>}{f.name}</td><td>{when(f.mtime)}</td><td>{bytes(f.size)}</td>
                    <td class="row-actions always">
                      <a class="icon-btn" href={`/api/admin/backups/${encodeURIComponent(f.name)}`} aria-label={`Pobierz ${f.name}`} title="Pobierz"><Icon name="download" size={16} /></a>
                      <button class="btn small ghost" onClick={() => inspect((p) => api.inspectRestore(f.name, p))} aria-label={`Przywróć ${f.name}`}><Icon name="history" size={14} />Przywróć</button>
                      <button class="icon-btn danger" onClick={() => del(f.name)} aria-label={`Usuń ${f.name}`}><Icon name="trash" size={16} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.files.length && <div class="empty">Brak kopii lokalnych.</div>}
          </div>
        ) : <p class="muted">Kopie lokalne są wyłączone (pusty <span class="mono">BACKUP_DIR</span>). Zdalne kopie nadal działają.</p>}
        <div class="encrypt-box">
          <label class="toggle"><input type="checkbox" checked={form.encrypt.enabled} onChange={(e) => set(['encrypt', 'enabled'], e.target.checked)} />
            Szyfruj kopie automatyczne hasłem (AES-256, pliki <span class="mono">.db.enc</span>)</label>
          {form.encrypt.enabled && (
            <Field label="Hasło szyfrowania" hint={cfg.encrypt.passphrase_set ? 'zapisane — wpisz nowe, by je zmienić (starsze kopie zachowają stare hasło)' : 'min. 8 znaków'}>
              <input type="password" autocomplete="new-password" value={form.encrypt.passphrase} placeholder={cfg.encrypt.passphrase_set ? '(zapisane)' : ''} onInput={(e) => set(['encrypt', 'passphrase'], e.target.value)} /></Field>
          )}
          <p class="muted small-text">Obejmuje kopie lokalne i wysyłane do chmury. <b>Zapamiętaj hasło poza aplikacją</b> — po awarii serwera będzie jedynym sposobem odczytu kopii. Ręczne „Pobierz teraz” pozostaje niezaszyfrowane. Poza aplikacją: <span class="mono">BACKUP_PASSPHRASE=… node src/cli.js decrypt plik.db.enc plik.db</span>.</p>
        </div>
        <div class="inline-field">
          <label>Przechowuj lokalnie ostatnie <input type="number" min="1" max="365" value={form.local_keep} onInput={(e) => set(['local_keep'], e.target.value)} /> kopii</label>
          <button class="btn small" disabled={busy === 'save'} onClick={save}>Zapisz</button>
        </div>
      </section>

      {cfg.gdrive.connected && (
        <section class="card span-2">
          <div class="card-head">
            <h3>Kopie na Dysku Google</h3>
            <button class="btn ghost" disabled={busy === 'drive'} onClick={loadDrive}>{busy === 'drive' ? 'Ładuję…' : drive ? 'Odśwież' : 'Pokaż kopie z Dysku'}</button>
          </div>
          {drive && (
            <div class="table-wrap flush">
              <table>
                <thead><tr><th>Plik</th><th>Utworzono</th><th>Rozmiar</th><th /></tr></thead>
                <tbody>
                  {drive.map((f) => (
                    <tr>
                      <td class="mono">{f.name}</td><td>{when(f.created)}</td><td>{bytes(f.size)}</td>
                      <td class="row-actions always"><button class="btn small ghost" disabled={busy === 'inspect'} onClick={() => inspect((p) => api.inspectDrive(f.id, p))}><Icon name="history" size={14} />Przywróć</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!drive.length && <div class="empty">Brak kopii w folderze na Dysku.</div>}
            </div>
          )}
        </section>
      )}

      <section class="card span-2">
        <h3>Kopia w chmurze</h3>
        <div class="segmented provider">
          {PROVIDERS.map(([k, l]) => <button type="button" class={form.provider === k ? 'on' : ''} onClick={() => set(['provider'], k)}>{l}</button>)}
        </div>

        {form.provider === 's3' && (
          <div class="form-grid">
            <Field label="Bucket"><input value={form.s3.bucket} onInput={(e) => set(['s3', 'bucket'], e.target.value)} placeholder="moj-ipam-backup" /></Field>
            <Field label="Region"><input value={form.s3.region} onInput={(e) => set(['s3', 'region'], e.target.value)} placeholder="eu-central-1" /></Field>
            <Field label="Access Key ID"><input class="mono" autocomplete="off" value={form.s3.access_key} onInput={(e) => set(['s3', 'access_key'], e.target.value)} /></Field>
            <Field label="Secret Access Key" hint={cfg.s3.secret_set ? 'zapisany — zostaw puste, by go nie zmieniać' : ''}>
              <input class="mono" type="password" autocomplete="new-password" value={form.s3.secret_key} placeholder={cfg.s3.secret_set ? '••••••••••••' : ''} onInput={(e) => set(['s3', 'secret_key'], e.target.value)} /></Field>
            <Field label="Prefiks (folder)"><input value={form.s3.prefix} onInput={(e) => set(['s3', 'prefix'], e.target.value)} placeholder="simpleipam/" /></Field>
            <Field label="Własny endpoint" hint="tylko dla MinIO, Cloudflare R2, Backblaze…"><input class="mono" value={form.s3.endpoint} onInput={(e) => set(['s3', 'endpoint'], e.target.value)} placeholder="https://…" /></Field>
          </div>
        )}

        {form.provider === 'gcs' && (
          <div class="form-grid">
            <Field label="Bucket"><input value={form.gcs.bucket} onInput={(e) => set(['gcs', 'bucket'], e.target.value)} placeholder="moj-ipam-backup" /></Field>
            <Field label="Prefiks (folder)"><input value={form.gcs.prefix} onInput={(e) => set(['gcs', 'prefix'], e.target.value)} placeholder="simpleipam/" /></Field>
            <Field span label="Klucz konta usługi (JSON)" hint={cfg.gcs.secret_set ? `zapisany dla ${cfg.gcs.client_email} — wklej nowy, by go zmienić` : 'IAM → Konta usługi → Klucze → Utwórz klucz JSON'}>
              <textarea class="mono key-area" rows="4" value={form.gcs.service_account_json} placeholder={cfg.gcs.secret_set ? '(zapisany)' : '{ "type": "service_account", … }'} onInput={(e) => set(['gcs', 'service_account_json'], e.target.value)} />
            </Field>
            <label class="btn small ghost span"><Icon name="upload" size={14} />Wczytaj z pliku<input type="file" accept=".json,application/json" hidden onChange={readKey} /></label>
          </div>
        )}

        {form.provider === 'gdrive' && (
          <div class="form-grid">
            {cfg.gdrive.connected ? (
              <div class="span connected">
                <span class="chip ok">Połączono</span> <b>{cfg.gdrive.email || 'konto Google'}</b>
                <button class="btn small ghost" disabled={busy === 'connect'} onClick={disconnect}>Odłącz</button>
              </div>
            ) : device ? (
              <div class="span device-box">
                <p>Otwórz <a href={device.verification_url} target="_blank" rel="noreferrer">{device.verification_url}</a> na dowolnym urządzeniu i wpisz kod:</p>
                <div class="device-code mono">{device.user_code}</div>
                <p class="muted small-text">Czekam na potwierdzenie…</p>
                <button class="btn small ghost" onClick={() => setDevice(null)}>Anuluj</button>
              </div>
            ) : (
              <div class="span">
                <p class="muted small-text">Zaloguj się raz swoim kontem Google. Aplikacja dostaje dostęp wyłącznie do plików i folderu, które sama utworzy (zakres <span class="mono">drive.file</span>) — nie widzi reszty Twojego Dysku.</p>
                <div class="form-actions">
                  <button class="btn primary" disabled={busy === 'connect' || !form.gdrive.client_id || !(form.gdrive.client_secret || cfg.gdrive.secret_set)} onClick={connect}>Połącz z Google</button>
                  <button class="btn ghost" disabled={busy === 'connect' || !form.gdrive.client_id || !(form.gdrive.client_secret || cfg.gdrive.secret_set)} onClick={connectDevice} title="Gdy aplikacja działa pod adresem http://192.168… — Google nie przyjmie takiego adresu przekierowania">Połącz kodem urządzenia</button>
                </div>
              </div>
            )}
            <Field label="Client ID"><input value={form.gdrive.client_id} onInput={(e) => set(['gdrive', 'client_id'], e.target.value)} placeholder="123…apps.googleusercontent.com" /></Field>
            <Field label="Client Secret" hint={cfg.gdrive.secret_set ? 'zapisany — wpisz nowy, by go zmienić' : ''}><input type="password" autocomplete="off" value={form.gdrive.client_secret} placeholder={cfg.gdrive.secret_set ? '(zapisany)' : ''} onInput={(e) => set(['gdrive', 'client_secret'], e.target.value)} /></Field>
            <Field label="Folder na Dysku"><input value={form.gdrive.folder_name} onInput={(e) => set(['gdrive', 'folder_name'], e.target.value)} placeholder="simpleIPAM backups" /></Field>
            <Field label="Ile kopii trzymać na Dysku" hint="0 = bez limitu"><input type="number" min="0" max="1000" value={form.gdrive.keep} onInput={(e) => set(['gdrive', 'keep'], e.target.value)} /></Field>
            <details class="span setup-help">
              <summary>Jak uzyskać Client ID i Secret?</summary>
              <ol class="small-text muted">
                <li>W <b>Google Cloud Console</b> utwórz projekt i włącz <b>Google Drive API</b>.</li>
                <li><b>Ekran zgody OAuth</b>: typ „Zewnętrzny”, dodaj siebie jako użytkownika testowego. W trybie „Testing” token wygasa po 7 dniach — opublikuj aplikację („In production”; dla własnego użytku nie wymaga weryfikacji), aby autoryzacja trwała.</li>
                <li><b>Dane logowania → Identyfikator klienta OAuth</b>: typ „Aplikacja internetowa” i adres przekierowania <span class="mono">{location.origin}/api/admin/backups/gdrive/callback</span> (działa dla https lub localhost). Dla adresu w sieci lokalnej wybierz typ „Telewizory i urządzenia o ograniczonym wejściu” i użyj przycisku „Połącz kodem urządzenia”.</li>
              </ol>
            </details>
          </div>
        )}

        {form.provider !== 'none' && (
          <>
            <label class="toggle span"><input type="checkbox" checked={form.remote_enabled} onChange={(e) => set(['remote_enabled'], e.target.checked)} />
              Wysyłaj codzienną kopię automatycznie do chmury</label>
            <div class="notes small-text muted">
              {form.provider === 'gdrive'
                ? <p>• Aplikacja usuwa z folderu tylko własne, najstarsze kopie (<span class="mono">ipam-…​.db</span>) ponad ustawiony limit.</p>
                : <p>• Aplikacja tylko <b>wysyła</b> pliki. Retencję ustaw po stronie chmury (reguły cyklu życia bucketa), a kluczowi nadaj minimalne uprawnienia (tylko zapis obiektów).</p>}
              <p>• Klucz dostępu (u Dysku Google: token odświeżania) jest zapisany w bazie, więc trafia też do kopii zapasowych. Traktuj kopie jak dane poufne.</p>
            </div>
          </>
        )}
        <div class="form-actions">
          <button class="btn primary" disabled={busy === 'save'} onClick={save}>Zapisz</button>
          {form.provider !== 'none' && <button class="btn ghost" disabled={busy === 'test'} onClick={test}>{busy === 'test' ? 'Testuję…' : 'Testuj połączenie'}</button>}
        </div>
      </section>
    </div>
  );
}
