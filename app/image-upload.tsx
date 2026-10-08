'use client';

import {useEffect, useRef, useState} from 'react';
import {ImagePlus, X} from 'lucide-react';
/* eslint-disable @next/next/no-img-element -- This temporary object URL is a local file preview, not a network image. */

type ImageUploadProps = {
  name: string;
  label: string;
  help: string;
  required?: boolean;
};

export default function ImageUpload({name, label, help, required = false}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  function removeFile() {
    setFile(null);
    setPreview('');
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="field image-upload-field">
      <span>{label}</span>
      <div className="image-upload">
        <div className="image-upload-preview">
          {preview ? (
            <>
              <img src={preview} alt={'Preview of ' + label} />
              <button className="image-upload-remove" type="button" onClick={removeFile} aria-label={'Remove ' + label} title="Remove photo">
                <X aria-hidden="true" />
              </button>
            </>
          ) : (
            <div className="image-upload-empty">
              <ImagePlus aria-hidden="true" />
              <span>Image preview will appear here</span>
            </div>
          )}
        </div>
        {file && <p className="image-upload-filename" title={file.name}>{file.name}</p>}
        <div className="image-upload-actions">
          <label className="button image-upload-choose">
            {file ? 'Choose another file' : 'Choose a file'}
            <input
              ref={inputRef}
              name={name}
              type="file"
              accept="image/jpeg,image/png"
              required={required && !file}
              onChange={event => {
                const selected = event.currentTarget.files?.[0] ?? null;
                setFile(selected);
                setPreview(selected ? URL.createObjectURL(selected) : '');
              }}
            />
          </label>
          {file && <button className="button" type="button" onClick={removeFile}>Remove photo</button>}
        </div>
        <small>{help}</small>
      </div>
    </div>
  );
}
