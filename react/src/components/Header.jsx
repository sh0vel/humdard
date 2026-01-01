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
  onBackClick 
}) {
  return (
    <header className="header">
      <div className="header-content">
        {showBackButton && (
          <button className="back-button" onClick={onBackClick} aria-label="Back to songs">
            ← Back
          </button>
        )}
        
        <h1 className="header-title">Humdard</h1>
        
        <div className="header-actions">
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showHindi}
              onChange={onToggleHindi}
              className="toggle-checkbox"
            />
            <span className="toggle-text">हिंदी</span>
          </label>

          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showWordByWord}
              onChange={onToggleWordByWord}
              className="toggle-checkbox"
            />
            <span className="toggle-text">Word-by-Word</span>
          </label>

          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showDirect}
              onChange={onToggleDirect}
              className="toggle-checkbox"
            />
            <span className="toggle-text">Direct</span>
          </label>

          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showNatural}
              onChange={onToggleNatural}
              className="toggle-checkbox"
            />
            <span className="toggle-text">Natural</span>
          </label>
          
          <button className="add-button" onClick={onAddClick}>
            + Add Lyrics
          </button>
        </div>
      </div>
    </header>
  );
}

export default Header;
