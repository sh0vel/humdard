import './TokenPopover.css';

function TokenPopover({ gloss, position }) {
  return (
    <div
      className="token-popover"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      <div className="popover-arrow"></div>
      <div className="popover-content">{gloss}</div>
    </div>
  );
}

export default TokenPopover;
