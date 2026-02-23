export const MOBILE_TOOL_NAMES = new Set<string>([
  'get_device_info',
  'get_sensor_data',
  'get_contacts',
  'get_location',
  'take_photo',
  'send_notification',
  'get_clipboard',
  'set_clipboard',
  'send_sms',
  'share_content',
  'trigger_haptic',
  'open_url',
])

export function isMobileToolName(name: string): boolean {
  return MOBILE_TOOL_NAMES.has(name)
}

