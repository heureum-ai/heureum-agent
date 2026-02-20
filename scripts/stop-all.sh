#!/bin/bash

# Stop all Heureum services
echo "Stopping all Heureum services..."

# Kill FastAPI (uvicorn) processes for heureum-agent
pkill -f "uvicorn app.main:app" && echo "✓ Stopped Agent (FastAPI)" || echo "  Agent not running"

# Kill MCP server for heureum-mcp
pkill -f "heureum-mcp.*src.main" && echo "✓ Stopped MCP Server" || echo "  MCP not running"

# Kill Django processes for heureum-platform
pkill -f "heureum-platform.*manage.py runserver" && echo "✓ Stopped Platform (Django)" || echo "  Platform not running"

# Kill Vite dev server for frontend
pkill -f "heureum-frontend.*vite" && echo "✓ Stopped Frontend (Vite)" || echo "  Frontend not running"

# Kill Electron processes
pkill -f "heureum-client.*electron" && echo "✓ Stopped Electron Client" || echo "  Electron not running"

# Alternative: Kill by port if process name doesn't work
lsof -ti:8000 | xargs kill -9 2>/dev/null && echo "✓ Killed process on port 8000"
lsof -ti:3001 | xargs kill -9 2>/dev/null && echo "✓ Killed process on port 3001"
lsof -ti:8001 | xargs kill -9 2>/dev/null && echo "✓ Killed process on port 8001"
lsof -ti:5173 | xargs kill -9 2>/dev/null && echo "✓ Killed process on port 5173"

echo ""
echo "All services stopped!"
