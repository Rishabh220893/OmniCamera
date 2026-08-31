import { Camera, Shield, Activity, Smartphone, Monitor, LucideIcon } from 'lucide-react';

export interface SetupGuide {
  id: string;
  title: string;
  brand: string;
  icon: LucideIcon;
  steps: { title: string; content: string; image?: string }[];
}

export const SETUP_GUIDES: SetupGuide[] = [
  {
    id: 'guide-cp-plus',
    title: 'CP PLUS / EzyCam Connection',
    brand: 'CP PLUS',
    icon: Camera,
    steps: [
      { title: 'Enable ONVIF', content: 'Open the EzyCam app, go to Settings > Device Version Information and tap the "Current Version" 5 times to reveal hidden developer settings. Look for "NAS" or "ONVIF" and enable it.' },
      { title: 'Find IP Address', content: 'In the Device Info screen, note down the Local IP Address (e.g., 192.168.1.5).' },
      { title: 'Configure RTSP', content: 'Use this format: rtsp://admin:password@IP_ADDRESS:554/cam/realmonitor?channel=1&subtype=1' }
    ]
  },
  {
    id: 'guide-hikvision',
    title: 'Hikvision / HiLook Integration',
    brand: 'Hikvision',
    icon: Shield,
    steps: [
      { title: 'SADP Tool', content: 'Download the Hikvision SADP tool on your PC to find the camera\'s IP and ensure it is in the same subnet.' },
      { title: 'Enable Hik-Connect', content: 'In the web interface (IE/Chrome), go to Configuration > Network > Advanced Settings > Platform Access and enable Hik-Connect.' },
      { title: 'Format URL', content: 'Standard URL: rtsp://username:password@IP_ADDRESS:554/Streaming/Channels/101' }
    ]
  },
  {
    id: 'guide-xiaomi',
    title: 'Xiaomi Mi Home (Hack)',
    brand: 'Xiaomi',
    icon: Activity,
    steps: [
      { title: 'Xiaomi Cloud V2', content: 'Xiaomi cameras usually don\'t support RTSP directly. You must use a bridge like the "Xiaomi Cloud Token Extractor".' },
      { title: 'Extract Credentials', content: 'Use the extractor tool to get the DID, Token, and Cloud IP.' },
      { title: 'Use Bridge', content: 'Input the extracted data into a bridge like Home Assistant to expose a WebRTC link.' }
    ]
  },
  {
    id: 'guide-phone',
    title: 'Use Phone as Camera',
    brand: 'Mobile',
    icon: Smartphone,
    steps: [
      { title: 'Install IP Webcam', content: 'Download "IP Webcam" (Android) or "EpochCam" (iOS) on the target device.' },
      { title: 'Start Server', content: 'Open the app and tap "Start Server" at the bottom.' },
      { title: 'Copy Link', content: 'Copy the IPv4 address shown and append /video (e.g., http://192.168.1.10:8080/video).' }
    ]
  },
  {
    id: 'guide-desktop',
    title: 'Monitor Desktop Screen',
    brand: 'Desktop',
    icon: Monitor,
    steps: [
      { title: 'OBS Setup', content: 'Install OBS Studio on your desktop.' },
      { title: 'Virtual Cam', content: 'Start the "Virtual Camera" inside OBS after setting up your scene.' },
      { title: 'Link to browser', content: 'This browser will detect the OBS Virtual Camera if you select "Local Feed" in node settings.' }
    ]
  }
];
