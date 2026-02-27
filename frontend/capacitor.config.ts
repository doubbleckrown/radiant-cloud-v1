import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId:   "com.fxradiant.app",
  appName: "FX Radiant",
  webDir:  "dist",
  server:  {
    androidScheme: "https",
    // Live reload during development — point to the Mac's LAN IP.
    // Remove or comment these two lines for a production build.
    url: "http://192.168.0.157:5173",
    cleartext: true,
  },
  plugins: {
    StatusBar: {
      style:           "dark",
      backgroundColor: "#050505",
      overlaysWebView: true,
    },
    SplashScreen: {
      launchShowDuration:       2000,
      launchAutoHide:           true,
      backgroundColor:          "#050505",
      androidSplashResourceName:"splash",
      showSpinner:              false,
    },
  },
  android: {
    minWebViewVersion: 90,
    buildOptions: {
      keystorePath:  "keystore/release.keystore",
      keystoreAlias: "fx-radiant",
    },
  },
  ios: {
    contentInset: "always",
    scheme:       "FXRadiant",
  },
};

export default config;