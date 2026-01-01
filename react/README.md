# Humdard - Learn Hindi Through Lyrics

A minimal, elegant React web app for learning Hindi through song lyrics with romanization.

## Features

- **Scrollable Lyrics View**: Clean, distraction-free reading experience
- **Romanization Primary**: Simple Latin transliteration (no diacritics) as the main reading surface
- **Optional Hindi Display**: Global toggle to show/hide Devanagari script
- **Interactive Translations**: Tap/click lines to cycle through direct and natural English translations
- **Token Glosses**: Hover (desktop) or long-press (mobile) on words to see meanings
- **Add New Lyrics**: Generate structured lessons from raw Hindi lyrics using OpenAI
- **Song Library**: Browse and load previously generated lessons

## Tech Stack

- React 18 (functional components, hooks)
- Vite (fast development and build)
- Vanilla CSS (no frameworks)
- Production API: `https://humdard-lyric-api.sh0vel.workers.dev`

## Getting Started

### Install Dependencies

```bash
npm install
```

### Run Development Server

```bash
npm run dev
```

Open http://localhost:3000

### Build for Production

```bash
npm run build
```

## Usage

### Viewing Lyrics

1. Open the app - you'll see a list of available songs
2. Click on a song to view its lyrics
3. Click the "हिंदी" toggle to show/hide Hindi script
4. Tap any line to cycle through translations:
   - State 0: Roman only
   - State 1: Direct translation (literal + grammatical)
   - State 2: Natural translation (expressive + fluent)
5. Hover over roman words (or long-press on mobile) to see glosses

### Adding New Lyrics

1. Click "+ Add Lyrics" in the header
2. Fill in the form:
   - Title (optional)
   - Artist (optional)
   - Hindi lyrics (required) - paste raw Devanagari text
3. Click "Generate"
4. Wait 15-30 seconds for AI processing
5. The new lesson will load automatically

### Direct URL Access

Share specific songs using query parameters:
```
http://localhost:3000/?songId=humdard-5e22f906
```

## Project Structure

```
react/
├── src/
│   ├── components/
│   │   ├── Header.jsx                 # App header with toggle and add button
│   │   ├── SongPicker.jsx             # Song list view
│   │   ├── LyricsViewer.jsx           # Main lyrics display
│   │   ├── LyricLine.jsx              # Individual line with state cycling
│   │   ├── TokenPopover.jsx           # Tooltip for word glosses
│   │   ├── AddLyricsModal.jsx         # Form for generating new lessons
│   │   └── *.css                      # Component styles
│   ├── api.js                         # API client (listSongs, getSong, jsonifyLyrics)
│   ├── App.jsx                        # Main app container with routing
│   ├── App.css                        # Global app styles
│   └── main.jsx                       # React entry point
├── index.html                         # HTML template
├── vite.config.js                     # Vite configuration
└── package.json                       # Dependencies
```

## API Integration

The app consumes the Humdard Lyric Learning API:

- `GET /api/songs` - List all songs
- `GET /api/songs/{songId}?tokens=true` - Get specific song
- `POST /api/jsonify` - Generate new lesson from raw lyrics

See `src/api.js` for implementation details.

## Design Philosophy

- **Mobile-first**: Optimized for phone screens while working great on desktop
- **Distraction-free**: No clutter, no complexity - just learn the lyrics
- **Progressive disclosure**: Information reveals on demand (translations, glosses)
- **Performance**: Fast loading, smooth animations, responsive interactions

## License

MIT
