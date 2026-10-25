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

export default function App() {
  return (
    <VoiceSessionProvider>
      <BrandBootstrap />
      <Routes>
        <Route path="/" element={<Navigate to="/comunidade" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/comunidade" element={<CommunityPage />} />
        <Route path="/comunidade/:serverId" element={<CommunityPage />} />
        <Route path="/comunidade/:serverId/:channelId" element={<CommunityPage />} />
        <Route path="/descobrir" element={<DiscoverPage />} />
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
