import { motion } from "framer-motion";

export default function TabBar({ tabs, activeTab, onTabChange }) {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40"
      style={{
        paddingBottom: "env(safe-area-inset-bottom)",
        background: "linear-gradient(to top, #050505 0%, rgba(5,5,5,0.97) 100%)",
        borderTop: "1px solid rgba(0,255,65,0.08)",
        backdropFilter: "blur(20px)",
      }}
    >
      <div className="flex items-center justify-around h-[72px] px-2 max-w-lg mx-auto">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className="relative flex flex-col items-center justify-center gap-1 flex-1 h-full group"
              style={{ WebkitTapHighlightColor: "transparent" }}
            >
              {/* Active background pill */}
              {isActive && (
                <motion.div
                  layoutId="tab-pill"
                  className="absolute inset-x-1 top-2 bottom-2 rounded-2xl"
                  style={{
                    background: "rgba(0, 255, 65, 0.06)",
                    border: "1px solid rgba(0, 255, 65, 0.12)",
                  }}
                  transition={{ type: "spring", stiffness: 400, damping: 35 }}
                />
              )}

              {/* Icon */}
              <motion.div
                animate={{
                  color: isActive ? "#00FF41" : "#4d4d4d",
                  filter: isActive
                    ? "drop-shadow(0 0 6px rgba(0,255,65,0.7)) drop-shadow(0 0 12px rgba(0,255,65,0.3))"
                    : "none",
                }}
                transition={{ duration: 0.2 }}
                className="relative z-10"
              >
                <Icon active={isActive} />
              </motion.div>

              {/* Label */}
              <motion.span
                animate={{ color: isActive ? "#00FF41" : "#404040" }}
                transition={{ duration: 0.2 }}
                className="relative z-10 text-[10px] font-display tracking-wider uppercase"
                style={{
                  textShadow: isActive ? "0 0 8px rgba(0,255,65,0.5)" : "none",
                }}
              >
                {tab.label}
              </motion.span>

              {/* Tap ripple */}
              <motion.div
                whileTap={{ scale: [0.95, 1] }}
                className="absolute inset-0"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}