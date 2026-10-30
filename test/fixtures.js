'use strict';
// Sample Docker output shaped like the real "king" server (used by tests and screenshots).
const hex = (c) => c.repeat(64);

// Shaped like `docker inspect` on the real "king" server.
function container(id, name, image, { project, service, running = true, mounts = [], ports = {} } = {}) {
  return {
    Id: hex(id), Name: '/' + name, Image: 'sha256:' + hex(id === 'a' ? 'f' : id),
    Created: '2026-10-29T10:00:00Z', RestartCount: 0,
    State: { Status: running ? 'running' : 'exited', Running: running, ExitCode: running ? 0 : 137, StartedAt: '2026-10-29T10:00:01Z', FinishedAt: '0001-01-01T00:00:00Z' },
    Config: { Image: image, Labels: project ? { 'com.docker.compose.project': project, 'com.docker.compose.service': service, 'com.docker.compose.project.working_dir': `/root/${project}` } : {}, Env: ['SECRET=do-not-show'], Cmd: ['node', 'server.js'] },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
    NetworkSettings: { Ports: ports, Networks: { [`${project || 'bridge'}_default`]: {} } },
    Mounts: mounts,
  };
}

function overviewText() {
  const cs = [
    container('a', 'king-backend-1', 'king-backend', { project: 'king', service: 'backend', ports: { '8082/tcp': [{ HostIp: '0.0.0.0', HostPort: '8082' }, { HostIp: '::', HostPort: '8082' }] }, mounts: [{ Type: 'volume', Name: 'king_upload', Destination: '/app/upload' }] }),
    container('b', 'king-redis-1', 'redis:6.2-alpine', { project: 'king', service: 'redis', ports: { '6379/tcp': null }, mounts: [{ Type: 'volume', Name: 'king_redis_data', Destination: '/data' }] }),
    container('c', 'king-web-1', 'king-web', { project: 'king', service: 'web', ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '3062' }] } }),
    container('d', 'king-db-1', 'mongo:4.0-xenial', { project: 'king', service: 'db', mounts: [{ Type: 'volume', Name: 'king_phone', Destination: '/data/db' }, { Type: 'volume', Name: hex('9'), Destination: '/data/configdb' }] }),
    container('e', 'shubh-web-1', 'shubh-web', { project: 'shubh', service: 'web', running: false }),
    container('0', 'portainer', 'portainer/portainer-ce', {}),
  ];
  const vol = (name, project, vname) => ({ Name: name, Mountpoint: `/var/lib/docker/volumes/${name}/_data`, Driver: 'local', Labels: project ? { 'com.docker.compose.project': project, 'com.docker.compose.volume': vname } : { 'com.docker.volume.anonymous': '' } });
  const vols = [vol('king_phone', 'king', 'phone'), vol('king_upload', 'king', 'upload'), vol('king_redis_data', 'king', 'redis_data'), vol(hex('9'), null), vol('old_stuff', null)];
  const S = '@@SNAP@@';
  return [`${S}version`, '29.9.2', `${S}containers`, JSON.stringify(cs), `${S}volumes`, JSON.stringify(vols), `${S}images`,
    `sha256:${hex('f')}\t["king-backend:latest"]\t150000000\t2026-10-29T09:00:00Z`,
    `sha256:${hex('b')}\t["redis:6.2-alpine"]\t30000000\t2026-01-01T00:00:00Z`,
    `sha256:${hex('7')}\t["<none>:<none>"]\t5000\t2025-01-01T00:00:00Z`].join('\n');
}

const usageText = ['@@SNAP@@stats', JSON.stringify({ Name: 'king-backend-1', CPUPerc: '1.20%', MemUsage: '80MiB / 3.8GiB', MemPerc: '2%' }),
  '@@SNAP@@sizes', 'king_phone 315096', 'king_upload 4036', 'king_redis_data 980', 'old_stuff 12',
  '@@SNAP@@host', '0.15 0.10 0.05 1/200 999', '2', '4000000 1500000', '100503408 8510000 91993528'].join('\n');

module.exports = { hex, container, overviewText, usageText };
