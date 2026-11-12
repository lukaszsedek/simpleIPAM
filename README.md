# simpleIPAM

Lekki IPAM do użytku domowego. Hierarchia: **tenant** (rodzina, firma…) → **lokalizacja** (dom1, lab2, cloud-aws…) → **sieć** (CIDR, VLAN, brama, DHCP, DNS) → **wpisy** (IP, FQDN, MAC, typ, status, tagi).

- mapa adresów sieci, „następny wolny IP” (omija bramę i pulę DHCP)
- inline-edycja w tabeli, wyszukiwarka globalna `⌘/Ctrl+K`, jasny/ciemny motyw
- skan ping, import/eksport CSV, dziennik zmian
- logowanie i rejestracja, role **Admin / Contributor / Reader / None** nadawane globalnie, per tenant lub per lokalizacja
- wykrywanie konfliktów (duplikaty MAC/FQDN, wpisy w puli DHCP, nakładające się sieci), eksport hosts / dnsmasq / BIND
- panel administratora (użytkownicy, kopie zapasowe, ustawienia, dziennik zmian)
- kopie zapasowe: pobieranie, przywracanie z UI (z podglądem i kopią bezpieczeństwa), dzienna kopia lokalna oraz wysyłka do **AWS S3** (i zgodnych: MinIO, R2, Backblaze) lub **Google Cloud Storage**
- tokeny API (Bearer), zbiorcza edycja i sortowanie, szukanie wolnych podsieci, skan okresowy z listą nowych urządzeń i „ostatnio widziany”
- jeden kontener, wbudowana baza SQLite (`/data/ipam.db`), zero zależności npm w backendzie

## Uruchomienie

```sh
docker compose up -d          # http://localhost:8080
# lub
docker run -d -p 8080:8080 -v ipam-data:/data ghcr.io/lukaszsedek/simpleipam:latest
```

Aplikacja nie ma domyślnego konta: pierwsze zarejestrowane konto zostaje administratorem.
Skan ping wymaga uruchomienia w sieci, którą ma skanować (`network_mode: host` dla sieci LAN).

## Obraz Docker i GitHub Actions

Workflow `.github/workflows/ci.yml` przy każdym pushu na `main` i tagu `v*`:

1. uruchamia testy (`npm test`),
2. buduje obraz, **uruchamia go** i sprawdza (`/api/health`, strona główna, rejestracja pierwszego admina),
3. buduje wieloarchitekturowy obraz (`linux/amd64` i `linux/arm64`, np. Raspberry Pi) i wypycha go do **GitHub Container Registry**: `ghcr.io/lukaszsedek/simpleipam`.

Pull requesty tylko budują i testują, nic nie publikują.

| Zdarzenie | Tagi obrazu |
|---|---|
| push na `main` | `latest`, `sha-<krótki hash>` |
| tag `v1.2.3` | `1.2.3`, `1.2`, `sha-…` |

Wydanie wersji: `git tag v1.0.0 && git push origin v1.0.0`.

Jednorazowo po pierwszym pushu: pakiet w GHCR jest domyślnie **prywatny**. Żeby można go było pobrać bez logowania, wejdź w *GitHub → Packages → simpleipam → Package settings → Change visibility → Public* (repozytorium jest publiczne, ale widoczność pakietu ustawia się osobno).

## Uprawnienia

Pierwsze zarejestrowane konto zostaje globalnym Adminem; kolejne mają rolę None, dopóki Admin nie nada uprawnień (zakładka *Użytkownicy*).
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
- Aplikacja tylko **wysyła** pliki — retencję ustaw regułami cyklu życia bucketa. Kluczowi nadaj minimalne uprawnienia.
- Klucze dostępu są zapisane w bazie (API nigdy ich nie zwraca), więc trafiają też do kopii. Traktuj kopie jak dane poufne.

### Przywracanie

Panel administratora → **Kopie zapasowe**: ikona zegara przy kopii na liście albo **Przywróć z pliku** (plik `.db` pobrany wcześniej lub z chmury).

1. Aplikacja sprawdza plik (czy to baza simpleIPAM, `integrity_check`), a starszą kopię sama aktualizuje do obecnego schematu.
2. Pokazuje porównanie „teraz → po przywróceniu” oraz ostrzeżenia, np. gdy w kopii nie ma żadnego globalnego administratora albo Twojego konta.
3. Po potwierdzeniu zapisuje **kopię bezpieczeństwa obecnego stanu** (na liście kopii — jej przywrócenie cofa operację), podmienia bazę bez restartu i wylogowuje wszystkich.

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
