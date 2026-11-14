# simpleIPAM

Lekki IPAM do użytku domowego. Hierarchia: **tenant** (rodzina, firma…) → **lokalizacja** (dom1, lab2, cloud-aws…) → **sieć** (CIDR, VLAN, brama, DHCP, DNS) → **wpisy** (IP, FQDN, MAC, typ, status, tagi).

- mapa adresów sieci, „następny wolny IP” (omija bramę i pulę DHCP)
- inline-edycja w tabeli, wyszukiwarka globalna `⌘/Ctrl+K`, jasny/ciemny motyw
- skan ping, import/eksport CSV, dziennik zmian
- logowanie i rejestracja, role **Admin / Contributor / Reader / None** nadawane globalnie, per tenant lub per lokalizacja
- wykrywanie konfliktów (duplikaty MAC/FQDN, wpisy w puli DHCP, nakładające się sieci), eksport hosts / dnsmasq / BIND
- panel administratora (użytkownicy, kopie zapasowe, ustawienia, dziennik zmian)
- kopie zapasowe: pobieranie, przywracanie z UI (z podglądem i kopią bezpieczeństwa), dzienna kopia lokalna oraz wysyłka do **AWS S3** (i zgodnych: MinIO, R2, Backblaze) **Google Cloud Storage** lub **Dysk Google** (jednorazowe logowanie przyciskiem)
- tokeny API (Bearer), zbiorcza edycja i sortowanie, szukanie wolnych podsieci, skan okresowy z listą nowych urządzeń i „ostatnio widziany”
- jeden kontener, wbudowana baza SQLite (`/data/ipam.db`), zero zależności npm w backendzie

## Uruchomienie

```sh
docker compose up -d          # http://localhost:8080
# lub
docker run -d -p 8080:8080 -v ipam-data:/data ghcr.io/lukaszsedek/simpleipam:latest
```

Aplikacja nie ma domyślnego konta. Przy pierwszym uruchomieniu pokaże ekran **„Utwórz konto administratora”** — pierwsze konto zawsze dostaje rolę globalnego Admina. Zrób to od razu po starcie: kto pierwszy otworzy nową instancję, ten zostaje adminem, więc nie wystawiaj jej publicznie przed konfiguracją.
Każda kolejna rejestracja tworzy konto z rolą **None** (bez dostępu do czegokolwiek); administrator widzi takie osoby w *Administracja → Użytkownicy* (znacznik „brak uprawnień” i licznik przy przycisku Administracja) i nadaje im role.
Skan ping wymaga uruchomienia w sieci, którą ma skanować (`network_mode: host` dla sieci LAN).

## Obraz Docker i GitHub Actions

Workflow `.github/workflows/ci.yml` przy każdym pushu na `main` i tagu wersji:

1. uruchamia testy (`npm test`); dla tagu sprawdza też, że wersja w `package.json` i `CHANGELOG.md` zgadza się z tagiem,
2. buduje obraz, **uruchamia go** i sprawdza (`/api/health`, strona główna, wersja, rejestracja pierwszego admina),
3. buduje wieloarchitekturowy obraz (`linux/amd64` i `linux/arm64`, np. Raspberry Pi) i wypycha go do **GitHub Container Registry**: `ghcr.io/lukaszsedek/simpleipam`,
4. dla tagu tworzy **GitHub Release** z opisem z `CHANGELOG.md`.

Pull requesty tylko budują i testują, nic nie publikują.

## Wersjonowanie

Projekt używa [SemVer](https://semver.org/lang/pl/) (`MAJOR.MINOR.PATCH`, np. `0.1.0`; do `1.0.0` zmiany niekompatybilne mogą wypadać w `MINOR`). Źródłem prawdy jest wersja w `server/package.json` (identyczna w `web/package.json`), a każde wydanie to tag git `vX.Y.Z`. Aktualna wersja jest widoczna w aplikacji (pasek boczny, Administracja → Ustawienia).

| Tag obrazu | Znaczenie |
|---|---|
| `0.1.0` | dokładnie to wydanie (niezmienne) |
| `0.1` | najnowsza łatka z linii `0.1.x` |
| `1` | najnowsze `1.x.y` (tylko od `1.0.0`) |
| `latest` | najnowsze **stabilne** wydanie (bez prerelease) |
| `edge` | bieżący `main` (może być niestabilny) |
| `sha-<hash>` | konkretny commit |

Do produkcji przypnij konkretną wersję (`…:0.1.0`) albo linię (`…:0.1`) zamiast `latest`.

### Jak wydać nową wersję

1. Opisz zmiany w `CHANGELOG.md` pod `## [Unreleased]`.
2. Uruchom (z czystego `main`):
   ```sh
   node scripts/release.mjs minor            # albo patch / major / konkretna wersja, np. 1.0.0-rc.1
   node scripts/release.mjs minor --dry-run  # tylko pokaż, co się stanie
   ```
   Skrypt uruchamia testy, podnosi wersję w `server/` i `web/`, zamienia `[Unreleased]` w nagłówek z datą, robi commit `Release vX.Y.Z` i tag. Niczego nie wypycha.
3. Wypchnij: `git push origin main --follow-tags`. Tag uruchamia pipeline: obraz z tagami powyżej i GitHub Release.

Wersje z myślnikiem (`1.0.0-rc.1`) są oznaczane jako prerelease i nie przesuwają `latest`.

Jednorazowo po pierwszym pushu: pakiet w GHCR jest domyślnie **prywatny**. Żeby można go było pobrać bez logowania, wejdź w *GitHub → Packages → simpleipam → Package settings → Change visibility → Public* (repozytorium jest publiczne, ale widoczność pakietu ustawia się osobno).

## Uprawnienia

Pierwsze konto (ekran pierwszego uruchomienia) zostaje globalnym Adminem; kolejne rejestracje mają rolę None, dopóki Admin nie nada uprawnień (Administracja → *Użytkownicy*).
Obowiązuje najbardziej szczegółowa rola: **lokalizacja → tenant → globalna** (np. Reader na tenancie + None na lab2 = brak dostępu do lab2). Rejestrację można wyłączyć w panelu *Użytkownicy*.

| Rola | Zakres |
|---|---|
| Reader | podgląd, wyszukiwanie, eksport CSV |
| Contributor | + dodawanie/edycja/usuwanie wpisów, skan, import |
| Admin (lokalizacji) | + edycja lokalizacji, dodawanie/edycja/usuwanie sieci |
| Admin (tenanta) | + dodawanie/usuwanie lokalizacji w tenancie |
| Admin (globalny) | + tworzenie/usuwanie tenantów, użytkownicy i role, dziennik zmian, backup |

Sesje to ciasteczko HttpOnly/SameSite=Lax (flaga Secure za proxy HTTPS lub przy `COOKIE_SECURE=1`). Hasła: scrypt.
Przy publikacji w internecie użyj HTTPS (reverse proxy) — rejestracja jest otwarta, ale nowe konta nie mają dostępu do niczego.
Skan ping wymaga uruchomienia w sieci, którą ma skanować (`network_mode: host` dla sieci LAN).

## API

Token tworzysz w aplikacji (ikona `</>` przy swoim koncie). Token ma te same uprawnienia co jego właściciel:

```sh
curl -H "Authorization: Bearer ipam_..." http://localhost:8080/api/overview
curl -H "Authorization: Bearer ipam_..." -H "content-type: application/json" \
  -d '{"ip":"192.168.1.50","fqdn":"printer.home.lan","type":"printer"}' http://localhost:8080/api/networks/1/entries
```

## Skan okresowy

Sieci z włączonym „Skanuj automatycznie” są pingowane co `SCAN_INTERVAL_MIN` minut (domyślnie 15, `0` wyłącza). Odpowiadające hosty dostają znacznik „widziany”, a nieznane trafiają na listę „Nowe urządzenia”. Kontener musi mieć dostęp do skanowanej sieci (`network_mode: host`).

## Kopie zapasowe

Panel administratora → **Kopie zapasowe**:

- **Pobierz teraz** — świeża, spójna migawka bazy (plik SQLite) prosto do przeglądarki.
- **Kopia dzienna** — raz dziennie aplikacja zapisuje kopię w `/data/backups` (liczbę kopii ustawiasz w panelu, domyślnie 7; `BACKUP_DIR=` puste wyłącza kopie lokalne). Pliki można pobrać lub usunąć z panelu.
- **Chmura** — wybierz dostawcę, podaj dane dostępowe i włącz „Wysyłaj codzienną kopię automatycznie”. Przycisk **Testuj połączenie** wysyła mały plik `simpleipam-connection-test.txt`.
  - *S3*: bucket, region, Access Key i Secret. Dla MinIO/R2/Backblaze podaj też własny endpoint.
  - *GCS*: bucket i klucz JSON konta usługi (rola z zapisem obiektów, np. Storage Object Creator).
  - *Dysk Google*: w Google Cloud Console włącz Drive API, utwórz identyfikator klienta OAuth i wpisz Client ID/Secret w aplikacji, potem kliknij **Połącz z Google**. Aplikacja dostaje tylko zakres `drive.file` (widzi wyłącznie własny folder z kopiami). Adres przekierowania to `<adres aplikacji>/api/admin/backups/gdrive/callback` i Google przyjmuje tylko `https://` lub `localhost`; przy adresie typu `http://192.168.x.x` użyj klienta „Telewizory i urządzenia o ograniczonym wejściu” oraz przycisku **Połącz kodem urządzenia**. Aplikację OAuth ustaw w trybie „In production”, bo w „Testing” token wygasa po 7 dniach.
- Aplikacja tylko **wysyła** pliki — retencję ustaw regułami cyklu życia bucketa. Kluczowi nadaj minimalne uprawnienia.
- Klucze dostępu są zapisane w bazie (API nigdy ich nie zwraca), więc trafiają też do kopii. Traktuj kopie jak dane poufne.

### Przywracanie

Panel administratora → **Kopie zapasowe**: ikona zegara przy kopii na liście albo **Przywróć z pliku** (plik `.db` pobrany wcześniej lub z chmury).

1. Aplikacja sprawdza plik (czy to baza simpleIPAM, `integrity_check`), a starszą kopię sama aktualizuje do obecnego schematu.
2. Pokazuje porównanie „teraz → po przywróceniu” oraz ostrzeżenia, np. gdy w kopii nie ma żadnego globalnego administratora albo Twojego konta.
3. Po potwierdzeniu zapisuje **kopię bezpieczeństwa obecnego stanu** (na liście kopii — jej przywrócenie cofa operację), podmienia bazę bez restartu i wylogowuje wszystkich.

### Historia zmian i wykrywanie zmiany MAC

Każdy wpis ma historię (ikona zegara w wierszu, a „Historia” nad tabelą pokazuje całą sieć): kto, kiedy i co zmienił (stara → nowa wartość). Skan odczytuje adresy MAC z tablicy ARP; gdy znany adres IP odpowiada innym MAC niż zapisany, wpis dostaje ostrzeżenie z przyciskami „Zatwierdź” (zapisuje nowy MAC) i „Ignoruj”. Aplikacja widzi MAC tylko w swoim segmencie L2, więc w Dockerze na Linuksie uruchom kontener z `network_mode: host` (w trybie bridge skan nadal działa, ale bez MAC).

### API

Dokumentacja wszystkich endpointów jest w aplikacji: `/api/docs` (czytelna strona) i `/api/openapi.json` (OpenAPI 3, do importu w Postmanie/Insomnii lub generatorach klientów). Uwierzytelnianie tokenem: `Authorization: Bearer ipam_…` (tokeny tworzysz w aplikacji).

### Logowanie przez Google

Administracja → Ustawienia → „Logowanie przez Google”. Utwórz w Google Cloud Console klienta OAuth typu „Aplikacja internetowa” z adresem przekierowania `<adres aplikacji>/api/auth/google/callback` (https lub localhost) i wpisz Client ID/Secret. Nowe konta Google powstają bez uprawnień (rola None) i podlegają przełącznikowi „Otwarta rejestracja”; istniejące konto łączysz z Google w oknie „Zmiana hasła”. Pierwszy administrator zawsze powstaje lokalnie.

Przywracane jest wszystko, co jest w bazie: dane, użytkownicy, role, tokeny API i ustawienia kopii (w tym klucze chmury). Pobieranie pliku z S3/GCS robisz poza aplikacją; limit wysyłanego pliku to `MAX_UPLOAD_MB` (domyślnie 512). Gdy utracisz dostęp do konta administratora po przywróceniu: `docker exec -it <kontener> node src/cli.js reset-admin <login>`.

## Reset hasła administratora

```sh
docker exec -it <kontener> node src/cli.js reset-admin <login> [nowe-hasło]   # bez hasła generuje losowe
```

## Rozwój

```sh
cd server && npm test && DB_PATH=../data/ipam.db npm start   # API na :8080 (Node >= 24)
cd web && npm install && npm run dev                          # UI na :5173, proxy do :8080
```
