import { useState, useEffect } from 'react';
import Header from './components/Header';
import SongPicker from './components/SongPicker';
import LyricsViewer from './components/LyricsViewer';
import AddLyricsModal from './components/AddLyricsModal';
import { getSong } from './api';
import './App.css';

function App() {
  const [showHindi, setShowHindi] = useState(false);
  const [showWordByWord, setShowWordByWord] = useState(false);
  const [showDirect, setShowDirect] = useState(false);
  const [showNatural, setShowNatural] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [lesson, setLesson] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Get songId from URL query params
  const getSongIdFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    return params.get('songId');
  };

  // Update URL with songId
  const updateUrl = (songId) => {
    const url = new URL(window.location);
    if (songId) {
      url.searchParams.set('songId', songId);
    } else {
      url.searchParams.delete('songId');
    }
    window.history.pushState({}, '', url);
  };

  // Load song from URL on mount
  useEffect(() => {
    const songId = getSongIdFromUrl();
    if (songId) {
      loadSong(songId);
    }
  }, []);

  const loadSong = async (songId) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSong(songId, true);
      setLesson(data);
      updateUrl(songId);
    } catch (err) {
      setError(err.message);
      setLesson(null);
    } finally {
      setLoading(false);
    }
  };

  const handleSongSelect = (songId) => {
    loadSong(songId);
  };

  const handleSongGenerated = (songId) => {
    setShowAddModal(false);
    loadSong(songId);
  };

  const handleBackToList = () => {
    setLesson(null);
    updateUrl(null);
  };

  return (
    <div className="app">
      <Header
        showHindi={showHindi}
        onToggleHindi={() => setShowHindi(!showHindi)}
        showWordByWord={showWordByWord}
        onToggleWordByWord={() => setShowWordByWord(!showWordByWord)}
        showDirect={showDirect}
        onToggleDirect={() => setShowDirect(!showDirect)}
        showNatural={showNatural}
        onToggleNatural={() => setShowNatural(!showNatural)}
        onAddClick={() => setShowAddModal(true)}
        showBackButton={!!lesson}
        onBackClick={handleBackToList}
        showBottomBar={!!lesson}
      />

      <main className="main">
        {loading && <div className="loading">Loading...</div>}
        
        {error && (
          <div className="error">
            <p>{error}</p>
            <button onClick={handleBackToList}>Back to songs</button>
          </div>
        )}

        {!loading && !error && !lesson && (
          <SongPicker onSongSelect={handleSongSelect} />
        )}

        {!loading && !error && lesson && (
          <LyricsViewer
            lesson={lesson}
            showHindi={showHindi}
            showWordByWord={showWordByWord}
            showDirect={showDirect}
            showNatural={showNatural}
          />
        )}
      </main>

      {showAddModal && (
        <AddLyricsModal
          onClose={() => setShowAddModal(false)}
          onSuccess={handleSongGenerated}
        />
      )}
    </div>
  );
}

export default App;
