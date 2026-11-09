import { DeviceChecks, DeviceSetupIntro } from '@/components/account/device-setup';

export const metadata = { title: 'Devices' };

export default function Page() {
  return (
    <div className="max-w-[1120px]">
      <DeviceSetupIntro headingId="devices-heading" as="h1" />
      <DeviceChecks />
    </div>
  );
}
