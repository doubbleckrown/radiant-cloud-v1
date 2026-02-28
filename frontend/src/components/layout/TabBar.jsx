/**
 * TabBar — Fixed bottom navigation
 * Identical glass treatment to the AccountPage sticky header:
 *   background:   rgba(5,5,5,0.97)
 *   backdropFilter: blur(20px)
 *   borderTop:    1px solid rgba(0,255,65,0.10)
 *
 * 100% inline styles — no Tailwind classes that could be purged.
 */
import { motion } from "framer-motion";

const C = {
  green:    "#00FF41",
  greenDim: "rgba(0,255,65,0.08)",
  greenBdr: "rgba(0,255,65,0.18)",
  inactive: "#3a3a3a",
  font:     "'Inter', sans-serif",
};

export default function TabBar({ tabs, activeTab, onTabChange }) {
  return (
    <div
      style={{
        position:        "fixed",
        bottom:          0,
        left:            0,
        width:           "100%",
        zIndex:          40,
        background:      "rgba(5,5,5,0.97)",
        backdropFilter:  "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderTop:       "1px solid rgba(0,255,65,0.10)",
        paddingBottom:   "env(safe-area-inset-bottom)",
      }}
    >
      <div
        style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-around",
          height:         72,
          maxWidth:        640,
          margin:         "0 auto",
          padding:        "0 8px",
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon     = tab.icon;

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              style={{
                position:          "relative",
                flex:              1,
                height:            "100%",
                display:           "flex",
                flexDirection:     "column",
                alignItems:        "center",
                justifyContent:    "center",
                gap:               4,
                background:        "transparent",
                border:            "none",
                cursor:            "pointer",
                WebkitTapHighlightColor: "transparent",
                fontFamily:        C.font,
              }}
            >
              {/* Active pill background */}
              {isActive && (
                <motion.div
                  layoutId="tab-active-pill"
                  style={{
                    position:     "absolute",
                    inset:        "8px 4px",
                    borderRadius: 14,
                    background:   C.greenDim,
                    border:       `1px solid ${C.greenBdr}`,
                  }}
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              )}

              {/* Icon */}
              <motion.div
                animate={{
                  color:  isActive ? C.green : C.inactive,
                  filter: isActive
                    ? "drop-shadow(0 0 5px rgba(0,255,65,0.65)) drop-shadow(0 0 10px rgba(0,255,65,0.25))"
                    : "none",
                }}
                transition={{ duration: 0.18 }}
                style={{ position: "relative", zIndex: 1 }}
              >
                <Icon active={isActive} />
              </motion.div>

              {/* Label */}
              <motion.span
                animate={{ color: isActive ? C.green : C.inactive }}
                transition={{ duration: 0.18 }}
                style={{
                  position:      "relative",
                  zIndex:        1,
                  fontSize:      10,
                  fontWeight:    isActive ? 600 : 500,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  textShadow:    isActive ? "0 0 8px rgba(0,255,65,0.45)" : "none",
                  fontFamily:    C.font,
                }}
              >
                {tab.label}
              </motion.span>

              {/* Tap ripple */}
              <motion.div
                whileTap={{ scale: 0.94 }}
                style={{ position: "absolute", inset: 0 }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}