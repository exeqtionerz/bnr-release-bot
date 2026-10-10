# BNR Release Bot

Bot de Telegram para Break Neck Records. Funciona así:

1. Subes un lanzamiento a Dropbox → `Break Neck Records/BNR RELEASES/Season X/BNR 0XX - Artista - Título`
2. El bot te avisa por Telegram: **🆕 Nuevo lanzamiento**
3. Lo abres: el bot lee la carpeta y elige solo qué archivo va a cada sitio (lo puedes cambiar):
   - **YouTube** → el vídeo horizontal (`releaser youtube.mp4`, `HDversion.mp4`…). Si no hay vídeo, genera uno 1920×1080 con la portada + el Extended Mix.
   - **Instagram Reel / TikTok** → el vídeo vertical (`Stories.mp4`). Si no tiene audio le pone el `- Video.wav`. Si no hay vídeo, genera uno 1080×1920 con la portada de stories + el trozo del drop.
   - **SoundCloud** → el Extended Mix (o el master) + la portada.
4. Te enseña los textos (título, descripción, hashtags) por plataforma y puedes editarlos.
5. Le das a **🚀 Publicar → ✅ Sí** y lo sube todo. Te devuelve los enlaces.

Lo que no esté conectado todavía no se pierde: el bot te prepara el archivo final, lo deja en Dropbox (`BNR BOT/`) y te lo manda por Telegram junto al texto para subirlo a mano en 10 segundos.

---

## Qué tienes que crear tú (una vez)

Las claves las creas y guardas tú; nadie más las ve. Van en el archivo `.env` del servidor.

| # | Qué | Dónde | Tiempo |
|---|-----|-------|--------|
| 1 | **Bot de Telegram** (obligatorio) | Telegram → @BotFather → `/newbot` → copia el token a `TELEGRAM_BOT_TOKEN` | 2 min |
| 2 | **Dropbox** (obligatorio) | dropbox.com/developers/apps → *Create app* → *Scoped access* → *Full Dropbox*. En **Permissions** marca `files.metadata.read`, `files.content.read`, `files.content.write`. En **Settings** añade el Redirect URI `http://localhost:8765/callback`. Copia *App key* y *App secret* al `.env` y ejecuta `npm run auth:dropbox` | 5 min |
| 3 | YouTube | console.cloud.google.com → proyecto nuevo → activa **YouTube Data API v3** → *Pantalla de consentimiento* (Externa, añádete como usuario de prueba) → *Credenciales* → ID de cliente OAuth tipo **Aplicación web** con redirect `http://localhost:8765/callback` → `npm run auth:youtube` | 10 min |
| 4 | Instagram | La cuenta tiene que ser **Profesional** (Creador o Empresa). developers.facebook.com → *Crear app* → producto **Instagram** → *API con inicio de sesión de Instagram* → genera el token de tu cuenta → pon `INSTAGRAM_USER_ID` y `INSTAGRAM_ACCESS_TOKEN`. El bot lo renueva solo cada semana. | 10 min |
| 5 | TikTok | developers.tiktok.com → *Manage apps* → app nueva → añade **Login Kit** + **Content Posting API** → redirect URI → `npm run auth:tiktok`. Hasta que TikTok apruebe la app, el vídeo te llega como **borrador** a la app de TikTok (`TIKTOK_MODE=inbox`). | 10 min + revisión |
| 6 | SoundCloud | soundcloud.com/you/apps → *Register a new application* (SoundCloud a veces tarda o no concede acceso) → redirect `http://localhost:8765/callback` → `npm run auth:soundcloud` | variable |
| 7 | Textos con IA (opcional) | console.anthropic.com → API key → `ANTHROPIC_API_KEY` | 2 min |

Puedes empezar solo con 1 y 2: todo lo demás funciona en modo "te lo dejo listo".

> Los comandos `npm run auth:*` se ejecutan **en tu ordenador** (necesitan abrir el navegador). Al terminar imprimen una línea `XXX_REFRESH_TOKEN=...` que copias al `.env` del servidor.

---

## Instalación en el VPS (Ubuntu, p.ej. el de TolaMix)

```bash
ssh root@TU_VPS
git clone https://github.com/exeqtionerz/bnr-release-bot.git /opt/bnr-release-bot
cd /opt/bnr-release-bot
bash deploy/install.sh        # instala Node 22 + ffmpeg y crea .env
nano .env                     # pega tus claves
bash deploy/install.sh        # arranca el servicio (se reinicia solo si se cae o se reinicia el VPS)
npm run check                 # comprueba conexiones sin publicar nada
```

Abre tu bot en Telegram y escribe `/start`. Si no pusiste `TELEGRAM_OWNER_ID`, el primero que escriba `/start` se queda como dueño (hazlo tú nada más arrancarlo). Nadie más puede usarlo.

- Ver logs: `journalctl -u bnr-release-bot -f`
- Actualizar a la última versión: `bash deploy/update.sh`
- Con Docker en vez de systemd: `docker compose up -d --build`

El bot usa *long polling*: no necesita dominio, puertos abiertos ni SSL.
Necesita espacio en disco temporal para los WAV/MP4 (unos GB); borra lo que tenga más de 3 días al reiniciar.

> El repo es privado: para clonarlo en el VPS usa `git clone https://<tu-usuario>:<token>@github.com/...` con un token *fine-grained* de solo lectura de este repo (GitHub → Settings → Developer settings), o pide que se haga público (no contiene ninguna clave).

---

## Comandos del bot

- `/lanzamientos` — lista los lanzamientos (los más nuevos primero)
- `/estado` — qué plataformas están conectadas
- `/menu` — menú principal
- Botón **🔍 Buscar nuevos** — mira Dropbox ahora mismo (también lo hace solo cada 15 min)

## Cómo decide los archivos

Por el nombre del archivo (en cualquier subcarpeta del lanzamiento):

| Nombre contiene | Se usa como |
|---|---|
| `Extended`, `Original Mix` | Audio completo → SoundCloud, vídeo de YouTube |
| `Video`, `Teaser`, `Preview` (.wav) | Audio corto → Reels/TikTok |
| `Stories`, `Reel`, `9-16`, `Vertical` | Vídeo/portada vertical |
| `youtube`, `HD`, `Wide`, `16-9` o carpeta `videos/` | Vídeo horizontal |
| `canvas` | Spotify canvas (no se sube) |
| `4-3`, `Wide` (imagen) | Portada horizontal / miniatura |

Si en una carpeta no acierta, cámbialo en **🗂 Cambiar archivos**.

## Desarrollo

```bash
npm install
npm test     # tests unitarios + flujo completo simulado (Dropbox/Telegram/plataformas falsos, ffmpeg real)
```

Estructura: `src/bot.js` (Telegram), `src/releases.js` (lectura y clasificación de Dropbox), `src/media.js` (ffmpeg), `src/pipeline.js` (preparar/publicar), `src/platforms/*` (YouTube, Instagram, TikTok, SoundCloud), `src/captions.js` (textos).
