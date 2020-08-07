import WebSocketClient from '@gamestdio/websocket';

let sharedConnection;

/**
 * @typedef Subscription
 * @property {string} channelName
 * @property {object} params
 * @property {function} onConnect
 * @property {function} onReceive
 * @property {function} onDisconnect
 */

const subscriptions = [];

/**
 * @param {Subscription} subscription
 */
const addSubscription = subscription => {
  subscriptions.push(subscription);
};

/**
 * @param {Subscription} subscription
 */
const removeSubscription = subscription => {
  const index = subscriptions.indexOf(subscription);
  subscriptions.splice(index, 1);
};

/**
 * @param {Subscription} subscription
 */
const subscribe = subscription => {
  const { channelName, params, onConnect } = subscription;
  sharedConnection.send(JSON.stringify({ type: 'subscribe', stream: channelName, ...params }));
  onConnect();
};

/**
 * @param {Subscription} subscription
 */
const unsubscribe = subscription => {
  const { channelName, params, onDisconnect } = subscription;
  sharedConnection.send(JSON.stringify({ type: 'unsubscribe', stream: channelName, ...params }));
  onDisconnect();
};

const sharedCallbacks = {
  connected () {
    subscriptions.forEach(subscription => subscribe(subscription));
  },

  received (data) {
    const { stream } = data;

    subscriptions.filter(({ channelName, params }) => {
      const streamChannelName = stream[0];

      if (stream.length === 1) {
        return channelName === streamChannelName;
      }

      const streamIdentifier = stream[1];

      if (['hashtag', 'hashtag:local'].includes(channelName)) {
        return channelName === streamChannelName && params.tag === streamIdentifier;
      } else if (channelName === 'list') {
        return channelName === streamChannelName && params.list === streamIdentifier;
      }

      return false;
    }).forEach(subscription => {
      subscription.onReceive(data);
    });
  },

  disconnected () {
    subscriptions.forEach(({ onDisconnect }) => onDisconnect());
  },

  reconnected () {
    subscriptions.forEach(subscription => subscribe(subscription));
  },
};

/**
 * @param {string} channelName
 * @param {object} params
 */
const channelNameWithInlineParams = (channelName, params) => {
  if (Object.keys(params).length === 0) {
    return channelName;
  }

  return `${channelName}&${Object.keys(params).map(key => `${key}=${params[key]}`).join('&')}`;
};

/**
 * @param {string} channelName
 * @param {object} params
 * @param {function} callbacks
 * @returns a function that disconnects the stream
 */
export const connectStream = (channelName, params, callbacks) => (dispatch, getState) => {
  const streamingAPIBaseURL = getState().getIn(['meta', 'streaming_api_base_url']);
  const accessToken = getState().getIn(['meta', 'access_token']);
  const { onConnect, onReceive, onDisconnect } = callbacks(dispatch, getState);

  // If we cannot use a websockets connection, we must fall back
  // to using individual connections for each channel
  if (!streamingAPIBaseURL.startsWith('ws')) {
    const connection = createConnection(streamingAPIBaseURL, accessToken, channelNameWithInlineParams(channelName, params), {
      connected () {
        onConnect();
      },

      received (data) {
        onReceive(data);
      },

      disconnected () {
        onDisconnect();
      },

      reconnected () {
        onConnect();
      },
    });

    return () => {
      connection.close();
    };
  }

  const subscription = {
    channelName,
    params,
    onConnect,
    onReceive,
    onDisconnect,
  };

  addSubscription(subscription);

  // If a connection is open, we can execute the subscription right now. Otherwise,
  // because we have already registered it, it will be executed on connect

  if (!sharedConnection) {
    sharedConnection = createConnection(streamingAPIBaseURL, accessToken, channelNameWithInlineParams(channelName, params), sharedCallbacks);
  } else if (sharedConnection.readyState === WebSocketClient.OPEN) {
    subscribe(subscription);
  }

  return () => {
    removeSubscription(subscription);
    unsubscribe(subscription);
  };
};


const KNOWN_EVENT_TYPES = [
  'update',
  'delete',
  'notification',
  'conversation',
  'filters_changed',
  'encrypted_message',
  'announcement',
  'announcement.delete',
  'announcement.reaction',
];

/**
 * @param {string} streamingAPIBaseURL
 * @param {string} accessToken
 * @param {string} channelName
 * @param {object} callbacks
 * @returns a websocket or eventsource client
 */
const createConnection = (streamingAPIBaseURL, accessToken, channelName, { connected, received, disconnected, reconnected }) => {
  const params = channelName.split('&');

  channelName = params.shift();

  if (streamingAPIBaseURL.startsWith('ws')) {
    params.unshift(`stream=${channelName}`);

    const ws = new WebSocketClient(`${streamingAPIBaseURL}/api/v1/streaming/?${params.join('&')}`, accessToken);

    ws.onopen      = connected;
    ws.onmessage   = e => received(JSON.parse(e.data));
    ws.onclose     = disconnected;
    ws.onreconnect = reconnected;

    return ws;
  }

  channelName = channelName.replace(/:/g, '/');
  params.push(`access_token=${accessToken}`);

  const es = new EventSource(`${streamingAPIBaseURL}/api/v1/streaming/${channelName}?${params.join('&')}`);

  let firstConnect = true;

  es.onopen = () => {
    if (firstConnect) {
      firstConnect = false;
      connected();
    } else {
      reconnected();
    }
  };

  KNOWN_EVENT_TYPES.forEach(type => {
    es.addEventListener(type, e => {
      received({
        event: e.type,
        payload: e.data,
      });
    });
  });

  es.onerror = disconnected;

  return es;
};
