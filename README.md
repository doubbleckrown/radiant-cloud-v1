# 🤖 Radiant Cloud — Automated Trading Bot

A full-stack automated trading application built with Python and React.
Features two separate trading engines — Bybit (crypto) and Oanda (forex).

🔗 **Live App:** https://radiant-cloud-v1.vercel.app

## 🚀 Features

- ⚡ **Auto Trade Execution** — Automatically places buy/sell orders 
based on market conditions
- 📊 **Signal Analysis** — Analyses market data to identify trading 
opportunities
- 🔔 **Live Price Tracking & Alerts** — Monitors prices in real time 
and triggers alerts
- 🛡️ **Risk Management** — Built-in stop loss controls to protect 
capital
- 🖥️ **Full Dashboard** — Clean React frontend to monitor and 
control the bot
- 🔐 **User Authentication** — Secure login and user management 
via Clerk

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python |
| Frontend | React |
| Auth | Clerk |
| Crypto Exchange | Bybit API |
| Forex Broker | Oanda API |
| Backend Hosting | Render |
| Frontend Hosting | Vercel |

## ⚙️ How It Works

1. User signs in securely via Clerk authentication
2. Bot connects to Bybit and Oanda via API
3. Bot monitors the market 24/7 and executes trades automatically
4. All trades, alerts and performance are visible on the dashboard

## 🔧 Setup & Installation
```bash
# Clone the repository
git clone https://github.com/doubbleckrown/radiant-cloud-v1.git

# Backend setup
cd backend
pip install -r requirements.txt
cp .env.example .env  # Add your API keys

# Frontend setup
cd ../frontend
npm install
npm run dev
```

## 📌 Environment Variables
```
BYBIT_API_KEY=your_bybit_api_key
BYBIT_API_SECRET=your_bybit_api_secret
OANDA_API_KEY=your_oanda_api_key
OANDA_ACCOUNT_ID=your_oanda_account_id
CLERK_SECRET_KEY=your_clerk_secret_key
```

## 👨‍💻 Author

Built by Abdulquadri Adedimeji — Python Developer specializing in 
automated trading bots for crypto and forex traders.

📩 Available for freelance work — doubbleckrown@gmail.com