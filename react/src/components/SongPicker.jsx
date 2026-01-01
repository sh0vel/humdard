import { useState, useEffect } from 'react';
import { listSongs } from '../api';
import { formatLastUpdated } from '../utils';
import './SongPicker.css';

function SongPicker({ onSongSelect }) {
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchSongs = async () => {
      try {
        const data = await listSongs();
        setSongs(data.songs || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchSongs();
  }, []);

  if (loading) {
    return <div className="song-picker-loading">Loading songs...</div>;
  }

  if (error) {
    return <div className="song-picker-error">Error: {error}</div>;
  }

  if (songs.length === 0) {
    return (
      <div className="song-picker-empty">
        <p>No songs yet.</p>
        <p className="hint">Click "Add Lyrics" to create your first lesson.</p>
      </div>
    );
  }

  return (
    <div className="song-picker">
      <h2 className="song-picker-title">Choose a song</h2>
      <ul className="song-list">
        {songs.map((song) => (
          <li key={song.songId} className="song-item">
            <button
              className="song-button"
              onClick={() => onSongSelect(song.songId)}
            >
              <div className="song-info">
                <div className="song-title">{song.title}</div>
                {song.artist && <div className="song-artist">{song.artist}</div>}
              </div>
              {song.updatedAt && (
                <div className="song-updated">{formatLastUpdated(song.updatedAt)}</div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default SongPicker;
