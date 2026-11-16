# Mój Dzień

Codzienna aplikacja na Androida: plan dnia, linki, przepisy z AI, zakupy, kwiaty, kalendarz, notatki, asystent.

## Jak dostać APK (bez instalowania czegokolwiek)

1. Załóż konto na github.com i utwórz nowe repozytorium (np. `moj-dzien`, może być prywatne).
2. Wgraj do niego całą zawartość tego folderu (Add file → Upload files). Ważne, żeby został folder `.github/workflows`.
3. Wejdź w zakładkę **Actions** → workflow **Build APK** → **Run workflow** (uruchomi się też samo po wgraniu).
4. Po ok. 5-8 minutach APK znajdziesz w **Releases** (prawa strona repozytorium) jako `MojDzien.apk`.
5. Na telefonie otwórz stronę repozytorium, pobierz `MojDzien.apk` i zainstaluj (włącz „Instaluj z nieznanych źródeł”).

## Klucz AI

W aplikacji: Więcej → Ustawienia → wklej klucz API Claude (console.anthropic.com). Bez klucza działa lokalny parser przepisów, ale bez rozpoznawania zdjęć i asystenta.

## Udostępnianie z innych aplikacji

W Instagramie, Chrome, YouTube itd. wybierz „Udostępnij” → „Mój Dzień”. Link lub tekst otworzy się w oknie dodawania.
