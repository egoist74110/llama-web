import React from 'react';
import {Audio, Sequence, staticFile} from 'remotion';
import manifestData from '../vo-manifest.json';
import {ChapterId, STORY} from '../story';

type ManifestEntry = {
  hash: string;
  seconds: number;
};

const manifest = manifestData as Record<string, ManifestEntry>;

export const Voice: React.FC<{chapter: ChapterId}> = ({chapter}) => {
  const story = STORY[chapter];
  if (!story) return null;

  return (
    <>
      {story.lines.map((line) => {
        const entry = manifest[line.id];
        // Lines with hash "estimate" have not been generated yet
        if (!entry || entry.hash === 'estimate') {
          return null;
        }

        return (
          <Sequence key={line.id} from={line.at} layout="none">
            <Audio src={staticFile(`vo/${line.id}.mp3`)} />
          </Sequence>
        );
      })}
    </>
  );
};
