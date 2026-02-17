interface ToolDefinition {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  guide?: string;
}

const GET_DEVICE_INFO_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_device_info',
  description:
    'Get information about the user\'s mobile device: model, OS, battery level, screen size, and memory.',
  parameters: { type: 'object', properties: {} },
};

const GET_SENSOR_DATA_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_sensor_data',
  description:
    'Get current sensor readings from the user\'s mobile device: accelerometer (x,y,z), gyroscope (x,y,z), and barometer (pressure in hPa).',
  parameters: { type: 'object', properties: {} },
};

const GET_CONTACTS_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_contacts',
  description:
    'Search the user\'s phone contacts. Returns names, phone numbers, and emails. Optionally filter by name.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional name to search for. Omit to get all contacts (up to 50).',
      },
    },
  },
};

const GET_LOCATION_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_location',
  description:
    'Get the user\'s current GPS location: latitude, longitude, altitude, and accuracy.',
  parameters: { type: 'object', properties: {} },
};

const TAKE_PHOTO_TOOL: ToolDefinition = {
  type: 'function',
  name: 'take_photo',
  description:
    'Open the device camera to take a photo. Returns the photo URI and dimensions. The user will see the native camera UI.',
  parameters: {
    type: 'object',
    properties: {
      camera: {
        type: 'string',
        enum: ['front', 'back'],
        description: 'Which camera to use. Defaults to back.',
      },
    },
  },
};

const SEND_NOTIFICATION_TOOL: ToolDefinition = {
  type: 'function',
  name: 'send_notification',
  description: 'Send a local push notification to the user\'s device with a title and body.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Notification title' },
      body: { type: 'string', description: 'Notification body text' },
    },
    required: ['title', 'body'],
  },
};

const GET_CLIPBOARD_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_clipboard',
  description: 'Read the current text content from the user\'s clipboard.',
  parameters: { type: 'object', properties: {} },
};

const SET_CLIPBOARD_TOOL: ToolDefinition = {
  type: 'function',
  name: 'set_clipboard',
  description: 'Copy text to the user\'s clipboard.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to copy to clipboard' },
    },
    required: ['text'],
  },
};

const READ_FILE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'read_file',
  description: 'Read a text file from the app\'s sandboxed document directory.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: "Relative file path within the app's document directory (e.g. 'notes/todo.txt')",
      },
    },
    required: ['path'],
  },
};

const WRITE_FILE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'write_file',
  description: 'Write text content to a file in the app\'s sandboxed document directory.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: "Relative file path within the app's document directory",
      },
      content: { type: 'string', description: 'Text content to write' },
    },
    required: ['path', 'content'],
  },
};

const LIST_FILES_TOOL: ToolDefinition = {
  type: 'function',
  name: 'list_files',
  description: 'List files in a directory within the app\'s sandboxed document directory.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative directory path. Omit or empty string for root document directory.',
      },
    },
  },
};

const SEND_SMS_TOOL: ToolDefinition = {
  type: 'function',
  name: 'send_sms',
  description:
    'Open the SMS compose screen with pre-filled recipients and message. The user must manually confirm sending.',
  parameters: {
    type: 'object',
    properties: {
      phones: {
        type: 'array',
        items: { type: 'string' },
        description: 'Phone number(s) to send to',
      },
      message: { type: 'string', description: 'Message text to pre-fill' },
    },
    required: ['phones', 'message'],
  },
};

const SHARE_CONTENT_TOOL: ToolDefinition = {
  type: 'function',
  name: 'share_content',
  description: 'Open the native share sheet to share text or a URL with other apps.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Text content to share' },
      url: { type: 'string', description: 'Optional URL to share' },
    },
    required: ['message'],
  },
};

const TRIGGER_HAPTIC_TOOL: ToolDefinition = {
  type: 'function',
  name: 'trigger_haptic',
  description: 'Trigger haptic feedback (vibration) on the user\'s device.',
  parameters: {
    type: 'object',
    properties: {
      style: {
        type: 'string',
        enum: ['light', 'medium', 'heavy'],
        description: 'Intensity of the haptic feedback. Defaults to medium.',
      },
    },
  },
};

const OPEN_URL_TOOL: ToolDefinition = {
  type: 'function',
  name: 'open_url',
  description: 'Open a URL in the device\'s in-app browser.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to open' },
    },
    required: ['url'],
  },
};

const MOBILE_TOOLS: ToolDefinition[] = [
  GET_DEVICE_INFO_TOOL,
  GET_SENSOR_DATA_TOOL,
  GET_CONTACTS_TOOL,
  GET_LOCATION_TOOL,
  TAKE_PHOTO_TOOL,
  SEND_NOTIFICATION_TOOL,
  GET_CLIPBOARD_TOOL,
  SET_CLIPBOARD_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  LIST_FILES_TOOL,
  SEND_SMS_TOOL,
  SHARE_CONTENT_TOOL,
  TRIGGER_HAPTIC_TOOL,
  OPEN_URL_TOOL,
];

export function getTools(): ToolDefinition[] {
  return MOBILE_TOOLS;
}
