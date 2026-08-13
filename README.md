# SmartAttend SaaS - WhatsApp & Dynamic QR Attendance Platform

## Overview
SmartAttend is a modern attendance management SaaS platform that uses 30-second rotating TOTP QR codes and official WhatsApp Cloud API integration to eliminate expensive biometric fingerprint hardware.

## Project Structure
- `server.js` - Node.js HTTP backend, TOTP HMAC engine, hours calculation logic, WhatsApp webhook handler.
- `public/landing.html` - SaaS marketing & sales landing page with pricing tiers.
- `public/index.html` - Interactive 4-view app suite (Kiosk Screen, WhatsApp Scanner, Admin Portal, Offline Badge).
- `public/app.js` - Client-side state manager, timer countdowns, and QR generator.

## Getting Started
1. Ensure Node.js (v16+) is installed.
2. Open terminal in this folder and run:
   ```bash
   node server.js
   ```
3. Open your browser:
   - **App Suite:** `http://localhost:3000`
   - **Marketing Landing Page:** `http://localhost:3000/landing.html`
