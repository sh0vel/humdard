import { useState } from 'react';
import TokenPopover from './TokenPopover';
import './LyricLine.css';

function LyricLine({ line, showHindi, showWordByWord, showDirect, showNatural }) {
  const [hoveredToken, setHoveredToken] = useState(null);
  const [popoverPosition, setPopoverPosition] = useState(null);
  const [longPressTimer, setLongPressTimer] = useState(null);

  const handleTokenHover = (token, event) => {
    const rect = event.target.getBoundingClientRect();
    setHoveredToken(token);
    setPopoverPosition({
      top: rect.top - 8,
      left: rect.left + rect.width / 2,
    });
  };

  const handleTokenLeave = () => {
    setHoveredToken(null);
    setPopoverPosition(null);
  };

  const handleTouchStart = (token, event) => {
    const timer = setTimeout(() => {
      const touch = event.touches[0];
      const rect = event.target.getBoundingClientRect();
      setHoveredToken(token);
      setPopoverPosition({
        top: rect.top - 8,
        left: rect.left + rect.width / 2,
      });
    }, 500); // 500ms for long press
    setLongPressTimer(timer);
  };

  const handleTouchEnd = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      setLongPressTimer(null);
    }
    // Auto-dismiss after 2s on mobile
    if (hoveredToken) {
      setTimeout(() => {
        setHoveredToken(null);
        setPopoverPosition(null);
      }, 2000);
    }
  };

  // Map tokens to roman words for interactive display
  const renderRomanWithTokens = () => {
    if (!line.tokens || line.tokens.length === 0) {
      return <span className="roman-text">{line.text.roman}</span>;
    }

    const romanWords = line.text.roman.split(/\s+/);
    const tokens = line.tokens;

    return (
      <span className="roman-text">
        {romanWords.map((word, idx) => {
          const token = tokens[idx] || null;
          if (token) {
            return (
              <span
                key={idx}
                className="roman-word"
                onMouseEnter={(e) => handleTokenHover(token, e)}
                onMouseLeave={handleTokenLeave}
                onTouchStart={(e) => handleTouchStart(token, e)}
                onTouchEnd={handleTouchEnd}
              >
                {word}{idx < romanWords.length - 1 ? ' ' : ''}
              </span>
            );
          }
          return <span key={idx}>{word}{idx < romanWords.length - 1 ? ' ' : ''}</span>;
        })}
      </span>
    );
  };

  return (
    <div className="lyric-line">
      {showHindi && (
        <div className="hindi-text">{line.text.target}</div>
      )}
      
      <div className="roman-line">
        {renderRomanWithTokens()}
      </div>

      {showWordByWord && (
        <div className="translation wordbyword">{line.text.wordByWord}</div>
      )}

      {showDirect && (
        <div className="translation direct">{line.text.direct}</div>
      )}

      {showNatural && (
        <div className="translation natural">{line.text.natural}</div>
      )}

      {hoveredToken && popoverPosition && (
        <TokenPopover
          gloss={hoveredToken.gloss}
          position={popoverPosition}
        />
      )}
    </div>
  );
}

export default LyricLine;
