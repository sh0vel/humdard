import './Header.css';

function Header({ 
  showHindi, 
  onToggleHindi, 
  showWordByWord,
  onToggleWordByWord,
  showDirect,
  onToggleDirect,
  showNatural,
  onToggleNatural,
  onAddClick, 
  showBackButton, 
  onBackClick,
  showBottomBar
}) {
  return (
    <>
      <header className="header">
        <div className="header-content">
          {showBackButton && (
            <button className="back-button" onClick={onBackClick} aria-label="Back to songs">
              ← Back
            </button>
          )}
          
          <h1 className="header-title">Samajh</h1>
          
          <button className="add-button" onClick={onAddClick}>
            + Add Lyrics
          </button>
        </div>
      </header>

      {showBottomBar && (
        <div className="bottom-bar">
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showHindi}
              onChange={onToggleHindi}
              className="toggle-checkbox"
            />
            <span className="toggle-text">हिं</span>
            <span className="toggle-label-text">Hindi</span>
          </label>

          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showWordByWord}
              onChange={onToggleWordByWord}
              className="toggle-checkbox"
            />
            <span className="toggle-text">W</span>
            <span className="toggle-label-text">Word</span>
          </label>

          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showDirect}
              onChange={onToggleDirect}
              className="toggle-checkbox"
            />
            <span className="toggle-text">D</span>
            <span className="toggle-label-text">Direct</span>
          </label>

          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showNatural}
              onChange={onToggleNatural}
              className="toggle-checkbox"
            />
            <span className="toggle-text">N</span>
            <span className="toggle-label-text">Natural</span>
          </label>
        </div>
      )}
    </>
  );
}

export default Header;
