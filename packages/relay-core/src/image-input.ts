/** Build Claude's multimodal stdin locally, keeping image bytes off argv. */
export const CLAUDE_IMAGE_INPUT_SCRIPT = `
const fs = require('node:fs');
const {prompt, images, target} = JSON.parse(process.argv[1]);
const content = [{type: 'text', text: prompt}, ...images.map(image => ({
  type: 'image', source: {type: 'base64', media_type: image.mediaType, data: fs.readFileSync(image.path).toString('base64')}
}))];
fs.writeFileSync(target, JSON.stringify({type: 'user', message: {role: 'user', content}, parent_tool_use_id: null}) + '\\n', {flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), mode: 0o600});
`;
