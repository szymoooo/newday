// Układ strony wzorowany na artykule sportowym z Interii (wywiad): reklamy, linki "czytaj także", zagnieżdżone polecane artykuły
// w środku tekstu i akapity rozdzielone <br>. Treść pochodzi z artykułu przesłanego przez użytkownika.
const ad = '<div class="ad-banner advert"><p>Reklama: kup teraz najlepszy kredyt gotówkowy w promocyjnej cenie tylko w tym miesiącu dla nowych klientów</p><a href="https://ad.example.com">Sprawdź</a></div>';
const teaser = t => '<article class="teaser related"><a href="/x"><h3>' + t + '</h3></a><p>Polecany artykuł z zupełnie innego tematu, który nie jest częścią wywiadu i nie powinien trafić do czytnika.</p></article>';
const html = `<!doctype html><html><head><title>Legenda krytycznie o polskim szkoleniu: u nas dzieci żyją meczami - Interia Sport</title><meta property="og:title" content="Legenda krytycznie o polskim szkoleniu"></head><body>
<header><nav><a>Sport</a><a>Koszykówka</a></nav></header>
<div class="layout"><main><article class="article-page">
<h1>Legenda krytycznie o polskim szkoleniu: u nas dzieci żyją meczami</h1>
<p class="lead">Wychowywanie młodego sportowca to proces, w którym liczy się praca na co dzień, a nie liczba rozegranych spotkań i turniejów.</p>
${ad}
<p><strong>Na co zwraca pan uwagę podczas treningów?</strong></p>
<p>- Każdy element ma duże znaczenie podczas wychowania młodego sportowca. Zwracamy uwagę na podejście do zajęć, etykę pracy i koncentrację. By odbyć dobry, jakościowy trening, trzeba umieć słuchać trenera. Jak trener mówi, to nie można czegoś robić po swojemu. Ktoś powie: "to proste rzeczy", ale to, co zawodnik robi po wyjściu z klubu, decyduje o tym, kim będzie.</p>
<p class="related-link">Czytaj także: Inny wywiad, którego nie chcemy w czytniku wcale i nigdy</p>
<p><strong>Właśnie. Czy można powiedzieć, że pan jest takim wsparciem dla klubów?</strong></p>
<p>- Powiem szczerze: 80% trenerów klubowych jest na "nie" względem tego, co robimy. Ja - jako ojciec - nigdy żadnemu trenerowi nie wtrącałem się do procesu treningowego. Moje dzieci szły na trening, tam miały trenera, który wykonywał swoją pracę.<br><br>Chciałbym podkreślić, że u nas panuje konkretna zasada: klub to świętość, a to, co robimy, to dodatek do pracy klubowej.</p>
${teaser('Zupełnie inny temat')}
<p><strong>Dlaczego w takim razie niektórzy trenerzy są na "nie"?</strong></p>
<p>- Dobrzy trenerzy nie mają nic przeciwko, oczywiście jeśli zajęcia indywidualne nie kolidują z treningami zespołowymi.</p>
<p>Inaczej jest z trenerami, którzy nie mają za wiele do zaproponowania i cały czas szukają drugiego dna. I pytają rodziców: "po co wydajecie pieniądze, jak u nas wszystko jest?"</p>
${ad}
${teaser('Kolejny polecany tekst')}
<p><strong>Na jakie elementy koszykarskiego rzemiosła zwraca pan uwagę podczas treningów?</strong></p>
<p>- Zajmujemy się wieloma elementami: szeroko pojętym kozłowaniem, wejściami pod kosz, kończeniem akcji w różnym stylu - rzuty sytuacyjne, reverse czy floatery.</p>
<p>Do tego oczywiście praca stóp, zwody. Powtarzam, że nie ma dobrych zwodów bez dobrej pracy stóp. Dlatego to wszystko trzeba umiejętnie połączyć.</p>
<p><strong>Koszykówka się zmienia, dochodzą nowe elementy - np. krok zero. Jak pan do tego podchodzi i skąd czerpie inspiracje do treningów?</strong></p>
<p>- Przez te 15 lat, gdy skończyłem karierę, rozwinąłem się niesamowicie. Spędziłem trzy lata w Hiszpanii, odbywając tam wiele różnych warsztatów, oczywiście przy okazji pracy w Estudiantes i w Real Betis Sevilla.</p>
<div class="recommended"><p>Polecamy także: materiał partnera, którego tutaj nie chcemy mieć w żadnym wypadku</p></div>
<p>- Chciałbym podkreślić jedną ważną rzecz: dzieciakom mówimy na każdym kroku - najpierw praca, później spotkania. W naszym systemie szkolenia wszystko jest zaprogramowane pod rozgrywanie jak największej liczby meczów. Dzieciaki i młodzież żyją meczami. Jak przyjdą na normalny trening, w którym trzeba pobiegać i dać trochę z siebie, to są zdziwione.</p>
<p>Czytaj więcej na sport.interia.pl w serwisie dla prenumeratorów wydawcy</p>
</article></main>
<aside><p>Najpopularniejsze: boczny panel z listą artykułów, który nie jest treścią tego tekstu wcale</p></aside></div>
<footer><p>Stopka serwisu: wszelkie prawa zastrzeżone przez wydawcę serwisu internetowego Interia</p></footer></body></html>`;
module.exports = { html, url: 'https://sport.interia.pl/koszykowka/reprezentacja-mezczyzn/news-legenda-krytycznie-o-polskim-szkoleniu-u-nas-dzieci-zyja-mec,nId,23579821?fbclid=IwY2xjawV2TatleHRuA2FlbQIxMABwZG9mAWJyaWQRMGJTakNTUFBQVTlkOEVrMW5zcnRjBmFwcF9pZBAyMjIwMzkxNzg4MjAwODkyAAEf70MeIdlQx3hZ-hNPY1b81lMdmIGs2EOPgwgiH5Ufx7AdHQm9KRjik-LbdJI_aem_8-E8VI2fnFvt532O9ieVlg' };
