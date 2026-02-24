import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Asymptomatic Biomarker Observer",
  description:
    "Passive extraction of physiological telemetry. The biological interface is temporary; structural decay is absolute. Observation is continuous.",
  metadataBase: new URL("https://unethical-face-insights.vercel.app/"),
  openGraph: {
    title: "Asymptomatic Biomarker Observer",
    description:
      "Passive extraction of physiological telemetry. The biological interface is temporary; structural decay is absolute. Observation is continuous.",
    url: "https://unethical-face-insights.vercel.app/",
    siteName: "A.B.O.",
    images: [
      {
        url: "https://images.unsplash.com/photo-1604871000636-074fa5117945?auto=format&fit=crop&q=80&w=1200&h=630", // Dark abstract, blood/cellular red and black
        width: 1200,
        height: 630,
        alt: "Abstract topography of biological degradation",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Asymptomatic Biomarker Observer",
    description:
      "Passive extraction of physiological telemetry. The biological interface is temporary; structural decay is absolute. Observation is continuous.",
    images: ["https://images.unsplash.com/photo-1604871000636-074fa5117945?auto=format&fit=crop&q=80&w=1200&h=630"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
