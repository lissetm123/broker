# Aether MQTT Broker Console

A beautiful, premium, single-purpose MQTT Broker designed to run over **WebSockets** in the cloud. It is fully optimized for **Google Cloud Run** routed through **Firebase Hosting** (the modern standard for containerized backend services in the Firebase suite).

---

## Features

- **Exclusive MQTT-over-WebSockets Protocol**: Designed specifically for cloud serverless containers where raw TCP/IP (port 1883) is not supported. Perfect for web dashboards, mobile apps, and modern IoT clients.
- **Interactive Web Console**: A dark-mode glassmorphic dashboard built directly into the server. It offers:
  - Live server metrics (Connections, Message count, Subscriptions, Memory, Uptime).
  - A built-in MQTT client to connect, subscribe to wildcards, and publish test payloads.
  - A scrollable, color-coded terminal showing real-time subscription feeds.
- **Environment-based Security**: Easily secure your broker in production by defining `MQTT_USERNAME` and `MQTT_PASSWORD` environment variables.
- **Firebase/Cloud Run Ready**: Pre-configured `Dockerfile` and `firebase.json` for rapid cloud deployment.

---

## Local Development & Testing

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start the Broker**:
   ```bash
   npm start
   ```

3. **Open the Console**:
   Navigate to `http://localhost:8080` in your web browser.
   - The built-in client will automatically fill in the connection URL (`ws://localhost:8080`).
   - Click **Connect Client** to activate the client.
   - Go to the **Subscribe** tab, input `home/#` and click **Subscribe**.
   - Go to the **Publish** tab, choose a preset or input your own topic/JSON payload, and click **Publish Message**.
   - Watch the live log terminal capture your publications!

---

## Firebase & Cloud Deployment Guide

Because standard Firebase Cloud Functions are stateless and terminate client sockets, the standard way to run a stateful MQTT broker in a Firebase project is to deploy to **Google Cloud Run** and route it through **Firebase Hosting**.

### Step 1: Deploy to Google Cloud Run
Google Cloud Run builds your container using the `Dockerfile` and deploys it as a serverless container.

1. Ensure you have the [Google Cloud CLI](https://cloud.google.com/sdk/gcloud) installed and authenticated.
2. Initialize your project and run the deployment command:
   ```bash
   gcloud run deploy aether-mqtt-broker --source . --allow-unauthenticated --region us-central1
   ```
3. During deployment, note down the generated service URL (e.g., `https://aether-mqtt-broker-xxxxxx-uc.a.run.app`).

### Step 2: Bind to Firebase Hosting (SSL WebSockets)
To map the broker to a nice domain (`wss://your-project.web.app/`) and ensure SSL connectivity, we route Firebase Hosting requests to the Cloud Run container.

1. Ensure you have the [Firebase CLI](https://firebase.google.com/docs/cli) installed:
   ```bash
   npm install -g firebase-tools
   ```
2. Log in and associate your directory with your Firebase Project:
   ```bash
   firebase login
   firebase use --add
   ```
   *(Select your active Firebase project from the list).*
3. Deploy Firebase Hosting using our prebuilt configuration:
   ```bash
   firebase deploy --only hosting
   ```
4. Once deployed, Firebase will provide your Hosting URL (e.g., `https://your-project.web.app`).
5. You can now connect your IoT devices or web pages securely using:
   - **WebSocket Connection URL**: `wss://your-project.web.app/`

---

## Securing your Broker

By default, the broker allows public developer access. To restrict connections:

1. Go to your **Google Cloud Console** -> **Cloud Run**.
2. Select your `aether-mqtt-broker` service and click **Edit & Deploy New Revision**.
3. Scroll to **Variables & Secrets** and add:
   - `MQTT_USERNAME` = `your_secure_username`
   - `MQTT_PASSWORD` = `your_secure_password`
4. Click **Deploy**. The broker will now refuse any MQTT connections that do not supply matching credentials, and the dashboard will automatically present login fields.
