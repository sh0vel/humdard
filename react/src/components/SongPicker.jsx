import { useState, useEffect } from 'react';
import { listSongs, deleteSong } from '../api';
import { formatLastUpdated } from '../utils';
import './SongPicker.css';

function SongPicker({ onSongSelect }) {
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

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

  const handleDelete = async (songId) => {
    try {
      await deleteSong(songId);
      setSongs(songs.filter(s => s.songId !== songId));
      setDeleteConfirm(null);
    } catch (err) {
      alert('Failed to delete song: ' + err.message);
    }
  };

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
            <div className="song-item-content">
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
              <button
                className="delete-button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteConfirm(song.songId);
                }}
                aria-label="Delete song"
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
      
      {deleteConfirm && (
        <div className="confirm-dialog-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Song?</h3>
            <p>This will permanently delete this song and cannot be undone.</p>
            <div className="confirm-dialog-buttons">
              <button onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="confirm-delete" onClick={() => handleDelete(deleteConfirm)}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SongPicker;
