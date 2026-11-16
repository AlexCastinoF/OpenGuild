import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { SetupPage } from './pages/SetupPage';
import { CommunityPage } from './pages/CommunityPage';
import { DiscoverPage } from './pages/DiscoverPage';
import { InvitePage } from './pages/InvitePage';
import { AdminPage } from './pages/AdminPage';
import { PublicWatchPage } from './pages/PublicWatchPage';
import { YoutubePage } from './pages/YoutubePage';
import { VetoPreviewPage } from './pages/VetoPreviewPage';
import { YoutubePlayerHost } from './components/youtube/YoutubePlayerHost';
import { VoiceSessionProvider } from './voice/VoiceSessionContext';
import { BrandBootstrap } from './components/BrandBootstrap';
import { CustomTitleBar } from './components/CustomTitleBar';

export default function App() {
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // Prevent browser native context menu ("Voltar", "Atualizar", "Imprimir", etc.)
      e.preventDefault();
    };
    window.addEventListener('contextmenu', handleContextMenu);
    return () => window.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  return (
    <VoiceSessionProvider>
      <BrandBootstrap />
      <CustomTitleBar />
      <Routes>
        <Route path="/" element={<Navigate to="/comunidade" replace />} />
        <Route path="/index.html" element={<Navigate to="/comunidade" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/comunidade" element={<CommunityPage />} />
        <Route path="/comunidade/:serverId" element={<CommunityPage />} />
        <Route path="/comunidade/:serverId/:channelId" element={<CommunityPage />} />
        <Route path="/descobrir" element={<CommunityPage />} />
        <Route path="/youtube" element={<YoutubePage />} />
        <Route path="/convite/:code" element={<InvitePage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/assistir/:slug" element={<PublicWatchPage />} />
        <Route path="/dev/veto" element={<VetoPreviewPage />} />
      </Routes>
      <YoutubePlayerHost />
    </VoiceSessionProvider>
  );
}
