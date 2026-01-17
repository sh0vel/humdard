import './LyricsViewer.css';
import LyricLine from './LyricLine';
import { formatLastUpdated } from '../utils';

function LyricsViewer({ lesson, showHindi, showWordByWord, showDirect, showNatural }) {
  if (!lesson || !lesson.sections) {
    return null;
  }

  return (
    <div className="lyrics-viewer">
      <div className="song-header">
        <h2 className="song-title">{lesson.title}</h2>
        {lesson.source?.artist && (
          <p className="song-artist">{lesson.source.artist}</p>
        )}
      </div>

      <div className="lyrics-content">
        {lesson.sections.flatMap((section) =>
          section.lines.map((line) => (
            <LyricLine
              key={line.lineId}
              line={line}
              showHindi={showHindi}
              showWordByWord={showWordByWord}
              showDirect={showDirect}
              showNatural={showNatural}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default LyricsViewer;
