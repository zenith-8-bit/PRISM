  /**
   * BackendConnector
   * Manages WebSocket connection to Python agentic AI backend
   * Handles real-time communication, action queuing, and state synchronization
   */

  export class BackendConnector {
    constructor(wsUrl, sessionId) {
      this.wsUrl = wsUrl;
      this.sessionId = sessionId;
      this.ws = null;
      this.isConnected = false;
      this.reconnectAttempts = 0;
      this.maxReconnectAttempts = 10;
      this.reconnectDelay = 2000;
      this.pendingActions = [];
      this.listeners = {};
      this.messageId = 0;
    }

    /**
     * Connect to backend WebSocket
     */
    async connect() {
      return new Promise((resolve, reject) => {
        try {
          const url = `${this.wsUrl}?session_id=${this.sessionId}`;
          this.ws = new WebSocket(url);

          this.ws.onopen = () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            console.log("[BackendConnector] Connected to backend");
            this.emit("connected", { timestamp: Date.now() });
            this._flushPendingActions();
            resolve();
          };

          this.ws.onmessage = (event) => {
            this._handleMessage(event.data);
          };

          this.ws.onerror = (error) => {
            console.error("[BackendConnector] WebSocket error:", error);
            this.emit("error", { message: "WebSocket error" });
          };

          this.ws.onclose = () => {
            this.isConnected = false;
            console.log("[BackendConnector] Disconnected from backend");
            this._attemptReconnect().then(resolve).catch(reject);
          };

          // Timeout for connection attempt
          setTimeout(() => {
            if (!this.isConnected) {
              reject(new Error("Connection timeout"));
            }
          }, 10000);
        } catch (err) {
          reject(err);
        }
      });
    }

    /**
     * Handle incoming messages from backend
     */
    _handleMessage(data) {
      try {
        const message = JSON.parse(data);
        const { type, id, payload } = message;

        if (type === "action") {
          this.emit("action_received", payload);
        } else if (type === "response") {
          this.emit(`response_${id}`, payload);
        } else if (type === "broadcast") {
          this.emit(payload.event, payload.data);
        } else {
          this.emit("message", message);
        }
      } catch (err) {
        console.error("[BackendConnector] Message parse error:", err);
      }
    }

    /**
     * Send message to backend
     */
    send(type, payload) {
      const message = {
        id: ++this.messageId,
        type: type,
        session_id: this.sessionId,
        timestamp: Date.now(),
        payload: payload
      };

      if (!this.isConnected) {
        this.pendingActions.push(message);
        return Promise.reject(new Error("Not connected"));
      }

      this.ws.send(JSON.stringify(message));

      // Return promise that resolves when response received
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.removeListener(`response_${message.id}`, listener);
          reject(new Error("Response timeout"));
        }, 30000);

        const listener = (response) => {
          clearTimeout(timeout);
          this.removeListener(`response_${message.id}`, listener);
          resolve(response);
        };

        this.on(`response_${message.id}`, listener);
      });
    }

    /**
     * Send screen state update
     */
    sendScreenUpdate(screenState) {
      return this.send("screen_update", {
        tab_id: screenState.tab_id,
        timestamp: screenState.timestamp,
        ui_elements: screenState.ui_elements,
        text_blocks: screenState.text_blocks,
        images: screenState.images,
        redaction_manifest: screenState.redaction_manifest,
        pii_vault: screenState.pii_vault
      });
    }

    /**
     * Send chat message
     */
    sendChatMessage(message, screenState) {
      return this.send("chat_message", {
        message: message,
        screen_state: screenState,
        timestamp: Date.now()
      });
    }

    /**
     * Report action result back to backend
     */
    reportActionResult(actionId, success, message) {
      return this.send("action_result", {
        action_id: actionId,
        success: success,
        message: message,
        timestamp: Date.now()
      });
    }

    /**
     * Flush pending actions when connection is restored
     */
    _flushPendingActions() {
      while (this.pendingActions.length > 0) {
        const action = this.pendingActions.shift();
        this.ws.send(JSON.stringify(action));
      }
    }

    /**
     * Attempt to reconnect with exponential backoff
     */
    async _attemptReconnect() {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        throw new Error("Max reconnection attempts exceeded");
      }

      this.reconnectAttempts++;
      const delay = Math.min(
        this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
        30000
      );

      console.log(
        `[BackendConnector] Reconnecting in ${delay}ms ` +
        `(attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
      return this.connect();
    }

    /**
     * Event emitter pattern
     */
    on(event, listener) {
      if (!this.listeners[event]) {
        this.listeners[event] = [];
      }
      this.listeners[event].push(listener);
    }

    removeListener(event, listener) {
      if (this.listeners[event]) {
        this.listeners[event] = this.listeners[event].filter(l => l !== listener);
      }
    }

    emit(event, data) {
      if (this.listeners[event]) {
        this.listeners[event].forEach(listener => {
          try {
            listener(data);
          } catch (err) {
            console.error(`[BackendConnector] Listener error for ${event}:`, err);
          }
        });
      }
    }

    /**
     * Close connection gracefully
     */
    close() {
      if (this.ws) {
        this.ws.close();
        this.isConnected = false;
      }
    }
  }

  /**
   * HTTP Client for REST endpoints
   */
  export class BackendHTTPClient {
    constructor(baseUrl, sessionId) {
      this.baseUrl = baseUrl;
      this.sessionId = sessionId;
    }

    async request(endpoint, options = {}) {
      const url = `${this.baseUrl}/api${endpoint}`;
      const config = {
        headers: {
          "Content-Type": "application/json",
          "X-Session-ID": this.sessionId,
          ...options.headers
        },
        ...options
      };

      try {
        const response = await fetch(url, config);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }

        return data;
      } catch (err) {
        console.error(`[BackendHTTPClient] Request failed:`, err);
        throw err;
      }
    }

    sendMessage(message, screenState) {
      return this.request(`/chat/${this.sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({
          message: message,
          screen_state: screenState
        })
      });
    }

    captureScreen(screenState) {
      return this.request("/screen/capture", {
        method: "POST",
        body: JSON.stringify({
          session_id: this.sessionId,
          ...screenState
        })
      });
    }

    clickElement(elementId, coordinates) {
      return this.request("/dom/click", {
        method: "POST",
        body: JSON.stringify({
          element_id: elementId,
          coordinates: coordinates
        })
      });
    }

    fillField(elementId, text) {
      return this.request("/dom/fill", {
        method: "POST",
        body: JSON.stringify({
          element_id: elementId,
          text: text
        })
      });
    }

    analyzeImages(images) {
      return this.request("/analyze/images", {
        method: "POST",
        body: JSON.stringify({
          images: images
        })
      });
    }
  }
