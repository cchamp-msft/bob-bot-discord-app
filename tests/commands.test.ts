/**
 * Slash command tests — exercises the GenerateCommand response handling
 * for attachment capping, fallback content, and embed toggling.
 */

jest.mock('discord.js', () => ({
  SlashCommandBuilder: jest.fn().mockImplementation(() => ({
    setName: jest.fn().mockReturnThis(),
    setDescription: jest.fn().mockReturnThis(),
    addStringOption: jest.fn().mockImplementation(function (this: any, fn: Function) {
      fn({
        setName: jest.fn().mockReturnThis(),
        setDescription: jest.fn().mockReturnThis(),
        setRequired: jest.fn().mockReturnThis(),
      });
      return this;
    }),
    name: 'generate',
  })),
  EmbedBuilder: jest.fn().mockImplementation(() => ({
    setColor: jest.fn().mockReturnThis(),
    setTitle: jest.fn().mockReturnThis(),
    setTimestamp: jest.fn().mockReturnThis(),
    addFields: jest.fn().mockReturnThis(),
  })),
}));

jest.mock('../src/utils/config', () => ({
  config: {
    getKeywordConfig: jest.fn(),
    getDefaultTimeout: jest.fn(() => 300),
    getErrorMessage: jest.fn(() => 'Error'),
    getImageResponseIncludeEmbed: jest.fn(() => false),
    getMaxAttachments: jest.fn(() => 2),
  },
}));

jest.mock('../src/utils/logger', () => ({
  logger: {
    logRequest: jest.fn(),
    logReply: jest.fn(),
    logError: jest.fn(),
  },
}));

jest.mock('../src/utils/requestQueue', () => ({
  requestQueue: { execute: jest.fn() },
}));

jest.mock('../src/api', () => ({
  apiManager: { executeRequest: jest.fn() },
}));

jest.mock('../src/utils/chunkText', () => ({
  chunkText: jest.fn((text: string) => [text]),
}));

jest.mock('../src/utils/fileHandler', () => ({
  fileHandler: {
    saveFromUrl: jest.fn(),
    shouldAttachFile: jest.fn(),
    readFile: jest.fn(),
  },
}));

import { config } from '../src/utils/config';
import { commands } from '../src/commands/commands';

const generateCommand = commands.find((c) => c.data.name === 'generate')!;

describe('GenerateCommand handleResponse', () => {
  const { fileHandler } = require('../src/utils/fileHandler');

  afterEach(() => {
    jest.clearAllMocks();
  });

  function createInteraction() {
    return {
      editReply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
    };
  }

  function mockSavedImage(index: number, attachable: boolean = true) {
    fileHandler.saveFromUrl.mockResolvedValueOnce({
      url: `http://localhost/img${index}.png`,
      filePath: `/tmp/img${index}.png`,
      fileName: `img${index}.png`,
      size: attachable ? 1000 : 999999999,
    });
    fileHandler.shouldAttachFile.mockReturnValueOnce(attachable);
    if (attachable) {
      fileHandler.readFile.mockReturnValueOnce(Buffer.from(`fake-${index}`));
    }
  }

  it('should cap attachments to maxAttachments per message', async () => {
    (config.getMaxAttachments as jest.Mock).mockReturnValue(2);
    (config.getImageResponseIncludeEmbed as jest.Mock).mockReturnValue(false);

    // 4 images, all attachable
    for (let i = 0; i < 4; i++) mockSavedImage(i);

    const interaction = createInteraction();
    const apiResult = {
      success: true,
      data: { images: ['a', 'b', 'c', 'd'] },
    };

    await (generateCommand as any).handleResponse(interaction, apiResult, 'testuser');

    // editReply should have first batch of 2
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ name: 'img0.png' }),
          expect.objectContaining({ name: 'img1.png' }),
        ]),
      })
    );
    const editCall = interaction.editReply.mock.calls[0][0];
    expect(editCall.files).toHaveLength(2);

    // followUp should have the remaining 2
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ name: 'img2.png' }),
          expect.objectContaining({ name: 'img3.png' }),
        ]),
        ephemeral: true,
      })
    );
  });

  it('should show fallback text when embed is off and no files are attachable', async () => {
    (config.getImageResponseIncludeEmbed as jest.Mock).mockReturnValue(false);
    (config.getMaxAttachments as jest.Mock).mockReturnValue(10);

    mockSavedImage(0, false); // not attachable

    const interaction = createInteraction();
    const apiResult = {
      success: true,
      data: { images: ['a'] },
    };

    await (generateCommand as any).handleResponse(interaction, apiResult, 'testuser');

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('1 image(s) generated and saved'),
      })
    );
  });

  it('should show empty content when embed is on even without attachable files', async () => {
    (config.getImageResponseIncludeEmbed as jest.Mock).mockReturnValue(true);
    (config.getMaxAttachments as jest.Mock).mockReturnValue(10);

    mockSavedImage(0, false);

    const interaction = createInteraction();
    const apiResult = {
      success: true,
      data: { images: ['a'] },
    };

    await (generateCommand as any).handleResponse(interaction, apiResult, 'testuser');

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '',
        embeds: expect.arrayContaining([expect.any(Object)]),
      })
    );
  });

  it('should show empty content when files are attachable (embed off)', async () => {
    (config.getImageResponseIncludeEmbed as jest.Mock).mockReturnValue(false);
    (config.getMaxAttachments as jest.Mock).mockReturnValue(10);

    mockSavedImage(0, true);

    const interaction = createInteraction();
    const apiResult = {
      success: true,
      data: { images: ['a'] },
    };

    await (generateCommand as any).handleResponse(interaction, apiResult, 'testuser');

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '',
      })
    );
  });
});
