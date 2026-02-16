"use client";

import { WebRecorder } from "../../components/dashboard/caps/components/web-recorder";

export default function QuickTestPage() {
  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column',
      justifyContent: 'center', 
      alignItems: 'center', 
      height: '100vh',
      backgroundColor: '#000',
      color: 'white'
    }}>
      <h1 style={{ marginBottom: '20px' }}>ໜ້າທົດສອບການອັດວິດີໂອ</h1>
      <div style={{ border: '2px solid #333', padding: '40px', borderRadius: '20px', background: '#111' }}>
        <WebRecorder />
      </div>
      <p style={{ marginTop: '20px', color: '#aaa' }}>
        ຖ້າເຫັນປຸ່ມແລ້ວ ລອງກົດ Start ເບິ່ງໄດ້ເລີຍ!
      </p>
    </div>
  );
}