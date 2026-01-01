import { useState } from 'react';
import { jsonifyLyrics } from '../api';
import './AddLyricsModal.css';

function AddLyricsModal({ onClose, onSuccess }) {
  const [titleHint, setTitleHint] = useState('');
  const [artistHint, setArtistHint] = useState('');
  const [rawLyrics, setRawLyrics] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!rawLyrics.trim()) {
      setError('Please enter lyrics');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const payload = {
        rawLyrics: rawLyrics.trim(),
      };
      
      if (titleHint.trim()) {
        payload.titleHint = titleHint.trim();
      }
      
      if (artistHint.trim()) {
        payload.artistHint = artistHint.trim();
      }

      const result = await jsonifyLyrics(payload);
      onSuccess(result.songId);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add New Lyrics</h2>
          <button className="close-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form className="modal-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="title">Title (optional)</label>
            <input
              id="title"
              type="text"
              value={titleHint}
              onChange={(e) => setTitleHint(e.target.value)}
              placeholder="e.g., Humdard"
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="artist">Artist (optional)</label>
            <input
              id="artist"
              type="text"
              value={artistHint}
              onChange={(e) => setArtistHint(e.target.value)}
              placeholder="e.g., Arijit Singh"
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="lyrics">
              Hindi Lyrics <span className="required">*</span>
            </label>
            <textarea
              id="lyrics"
              value={rawLyrics}
              onChange={(e) => setRawLyrics(e.target.value)}
              placeholder="Paste Hindi lyrics here (one line per line)"
              rows={12}
              maxLength={30000}
              required
              disabled={loading}
            />
            <div className="char-count">
              {rawLyrics.length} / 30,000 characters
            </div>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="form-actions">
            <button
              type="button"
              className="cancel-button"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="submit-button"
              disabled={loading}
            >
              {loading ? 'Generating...' : 'Generate'}
            </button>
          </div>

          {loading && (
            <div className="loading-note">
              This may take 15-30 seconds...
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export default AddLyricsModal;
