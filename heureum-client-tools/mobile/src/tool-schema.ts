import type { ToolDefinition } from './types.js'

export const GET_DEVICE_INFO_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_device_info',
  display_name: 'Device Info',
  description: 'Get mobile device info: model, OS, battery, screen size, memory.',
  parameters: { type: 'object', properties: {} },
}

export const GET_SENSOR_DATA_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_sensor_data',
  display_name: 'Sensor Data',
  description: 'Get live sensor readings: accelerometer, gyroscope, barometer.',
  parameters: { type: 'object', properties: {} },
}

export const GET_CONTACTS_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_contacts',
  display_name: 'Contacts',
  description: 'Get contacts from device address book.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional search query' },
      limit: { type: 'number', description: 'Maximum number of contacts (default: 50)' },
    },
  },
}

export const GET_LOCATION_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_location',
  display_name: 'Location',
  description: 'Get current GPS coordinates and address.',
  parameters: { type: 'object', properties: {} },
}

export const TAKE_PHOTO_TOOL: ToolDefinition = {
  type: 'function',
  name: 'take_photo',
  display_name: 'Take Photo',
  description: 'Take a photo using camera and return as base64 image.',
  parameters: {
    type: 'object',
    properties: {
      quality: { type: 'number', description: 'Image quality 0-100 (default: 80)' },
      camera: { type: 'string', enum: ['front', 'back'], description: 'Camera to use' },
    },
  },
}

export const SEND_NOTIFICATION_TOOL: ToolDefinition = {
  type: 'function',
  name: 'send_notification',
  display_name: 'Notification',
  description: 'Send a local push notification on the device.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Notification title' },
      body: { type: 'string', description: 'Notification body' },
    },
    required: ['title', 'body'],
  },
}

export const GET_CLIPBOARD_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_clipboard',
  display_name: 'Get Clipboard',
  description: 'Get current clipboard text content.',
  parameters: { type: 'object', properties: {} },
}

export const SET_CLIPBOARD_TOOL: ToolDefinition = {
  type: 'function',
  name: 'set_clipboard',
  display_name: 'Set Clipboard',
  description: 'Set clipboard text content.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to copy to clipboard' },
    },
    required: ['text'],
  },
}

export const SEND_SMS_TOOL: ToolDefinition = {
  type: 'function',
  name: 'send_sms',
  display_name: 'Send SMS',
  description: 'Send SMS message via device messaging app.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient phone number' },
      message: { type: 'string', description: 'SMS message body' },
    },
    required: ['to', 'message'],
  },
}

export const SHARE_CONTENT_TOOL: ToolDefinition = {
  type: 'function',
  name: 'share_content',
  display_name: 'Share',
  description: 'Open native share sheet with text or URL.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to share' },
      url: { type: 'string', description: 'URL to share' },
      title: { type: 'string', description: 'Optional share title' },
    },
  },
}

export const TRIGGER_HAPTIC_TOOL: ToolDefinition = {
  type: 'function',
  name: 'trigger_haptic',
  display_name: 'Haptic',
  description: 'Trigger device haptic feedback vibration.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['light', 'medium', 'heavy', 'success', 'warning', 'error'],
        description: 'Haptic feedback type',
      },
    },
  },
}

export const OPEN_URL_TOOL: ToolDefinition = {
  type: 'function',
  name: 'open_url',
  display_name: 'Open URL',
  description: 'Open URL in external browser or app.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to open' },
    },
    required: ['url'],
  },
}

export const MOBILE_TOOLS: ToolDefinition[] = [
  GET_DEVICE_INFO_TOOL,
  GET_SENSOR_DATA_TOOL,
  GET_CONTACTS_TOOL,
  GET_LOCATION_TOOL,
  TAKE_PHOTO_TOOL,
  SEND_NOTIFICATION_TOOL,
  GET_CLIPBOARD_TOOL,
  SET_CLIPBOARD_TOOL,
  SEND_SMS_TOOL,
  SHARE_CONTENT_TOOL,
  TRIGGER_HAPTIC_TOOL,
  OPEN_URL_TOOL,
]

