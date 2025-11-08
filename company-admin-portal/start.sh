#!/bin/bash

# Company Admin Portal Startup Script
# Starts the Node.js Express server on port 3010

echo "========================================================================"
echo " Starting Company Admin Portal"
echo "========================================================================"

# Change to portal directory
cd "$(dirname "$0")"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "⚠️  Dependencies not installed. Running npm install..."
    npm install
fi

# Set port
PORT=3010

# Kill any existing process on port 3010
echo "📍 Checking for existing process on port $PORT..."
EXISTING_PID=$(lsof -ti:$PORT)
if [ ! -z "$EXISTING_PID" ]; then
    echo "⚠️  Killing existing process $EXISTING_PID on port $PORT"
    kill -9 $EXISTING_PID 2>/dev/null
    sleep 1
fi

# Start server
echo "🚀 Starting Company Admin Portal on port $PORT..."
PORT=$PORT node server.js > /tmp/company-admin.log 2>&1 &
SERVER_PID=$!

# Wait a moment for server to start
sleep 2

# Check if server is running
if ps -p $SERVER_PID > /dev/null; then
    echo "✅ Company Admin Portal started successfully!"
    echo "   PID: $SERVER_PID"
    echo "   Port: $PORT"
    echo "   Local: http://localhost:$PORT"
    echo "   Domain: https://identuslabel.cz/company-admin"
    echo "   Logs: /tmp/company-admin.log"
    echo "========================================================================"
    echo ""
    echo "To view logs: tail -f /tmp/company-admin.log"
    echo "To stop: kill $SERVER_PID"
    echo ""
else
    echo "❌ Failed to start server. Check logs:"
    tail -20 /tmp/company-admin.log
    exit 1
fi
