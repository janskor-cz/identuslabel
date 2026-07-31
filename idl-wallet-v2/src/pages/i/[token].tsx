import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async ({ params, req }) => {
  const token = params?.token as string;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const apiUrl = `${proto}://${host}/wallet/api/shorten?token=${token}`;

  try {
    const r = await fetch(apiUrl);
    if (r.ok) {
      const { url } = await r.json();
      return { redirect: { destination: url, permanent: false } };
    }
  } catch {}

  return { notFound: true };
};

export default function ShortLinkPage() { return null; }
