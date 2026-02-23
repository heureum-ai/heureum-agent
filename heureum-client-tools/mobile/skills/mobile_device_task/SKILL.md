---
name: mobile_device_task
description: Use mobile-native capabilities such as sensors, contacts, camera, and sharing.
tools: get_device_info, get_sensor_data, get_contacts, get_location, take_photo, send_notification, get_clipboard, set_clipboard, send_sms, share_content, trigger_haptic, open_url
---
Use this skill when the user asks for device-native actions on mobile.

Workflow:
1. Read the request and pick the minimal mobile tool needed.
2. For contact/location/camera actions, ask for permission-friendly confirmation when needed.
3. Return concise, structured results and include key fields only.

Rules:
- Never fabricate device data.
- If a permission is denied or a tool fails, report the exact failure and suggest a retry path.

