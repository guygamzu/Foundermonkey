import { Suspense } from 'react';
import CreditsContent from './CreditsContent';

export default function CreditsPage() {
  return (
    <Suspense fallback={<div className="status-page"><p>Loading...</p></div>}>
      <CreditsContent />
    </Suspense>
  );
}
