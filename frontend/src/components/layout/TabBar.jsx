/**
 * TabBar — Fixed bottom navigation.
 * Reads the active accent color from authStore so it follows the FOREX/CRYPTO
 * mode switcher in real time.  All other colors remain hardcoded.
 */
import { motion } from "framer-motion";
import { useTheme } from "../../hooks/useTheme";

const FONT = "'Inter', sans-serif";

export default function TabBar({ tabs, activeTab, onTabChange }) {
  const { accent, accentDim, accentBdr } = useTheme();

  return (
    <div
      style={{
        position:             "fixed",
        bottom:               0,
        left:                 0,
        width:                "100%",
        zIndex:               40,
        background:           "rgba(5,5,5,0.97)",
        backdropFilter:       "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderTop:            `1px solid ${accentBdr}40`,
        paddingBottom:        "env(safe-area-inset-bottom)",
      }}
    >
      <div
        style={{
          display:        "flex",
          alignItems:     "center",
          justifyContent: "space-around",
          height:         72,
          maxWidth:       640,
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
                position:                "relative",
                flex:                    1,
                height:                  "100%",
                display:                 "flex",
                flexDirection:           "column",
                alignItems:              "center",
                justifyContent:          "center",
                gap:                     4,
                background:              "transparent",
                border:                  "none",
                cursor:                  "pointer",
                WebkitTapHighlightColor: "transparent",
                fontFamily:              FONT,
              }}
            >
              {isActive && (
                <motion.div
                  layoutId="tab-active-pill"
                  style={{
                    position:     "absolute",
                    inset:        "8px 4px",
                    borderRadius: 14,
                    background:   accentDim,
                    border:       `1px solid ${accentBdr}`,
                  }}
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              )}
              <motion.div
                animate={{
                  color:  isActive ? accent : "#3a3a3a",
                  filter: isActive
                    ? `drop-shadow(0 0 5px ${accent}a6) drop-shadow(0 0 10px ${accent}40)`
                    : "none",
                }}
                transition={{ duration: 0.18 }}
                style={{ position: "relative", zIndex: 1 }}
              >
                <Icon active={isActive} />
              </motion.div>
              <motion.span
                animate={{ color: isActive ? accent : "#3a3a3a" }}
                transition={{ duration: 0.18 }}
                style={{
                  position:      "relative",
                  zIndex:        1,
                  fontSize:      10,
                  fontWeight:    isActive ? 600 : 500,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  textShadow:    isActive ? `0 0 8px ${accent}72` : "none",
                  fontFamily:    FONT,
                }}
              >
                {tab.label}
              </motion.span>
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